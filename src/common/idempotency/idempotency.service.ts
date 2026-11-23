import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdempotencyRecord, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../locks/locks.constants';
import { IdempotencyConfig, idempotencyConfig } from '../../config/idempotency.config';
import { PrismaService } from '../../database/prisma.service';
import {
  IdempotencyHandle,
  IdempotencyInFlightError,
  IdempotencyMismatchError,
  IdempotencyScope,
  StoredIdempotentResponse,
} from './idempotency.types';
import {
  computeRequestFingerprint,
  hashIdempotencyKey,
} from './request-fingerprint';
import {
  IDEMPOTENT_REPLAY,
  IDEMPOTENT_REPLAY_REQUEST_ID,
  IDEMPOTENT_REPLAY_STATUS,
} from './idempotency.constants';
import { ConflictException, DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { RequestContext } from '../context/request-context';

const MIN_LOCK_TTL_MS = 30_000;

/** Compare-and-delete so a slow request cannot release another's lock. */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Identity of an idempotency record: credential scope + route + key digest. */
export interface IdempotencyIdentity {
  principalId: string;
  scope: string;
  route: string;
  keyHash: string;
}

/** The parts of a completed record that are replayed to the client. */
export interface IdempotentResponse {
  statusCode: number;
  body: Prisma.JsonValue;
  requestId?: string | null;
}

export interface ReserveIdempotencyInput {
  principalId: string;
  scope?: string;
  route: string;
  key: string;
  requestFingerprint: string;
  expiresAt: Date;
  /** Injectable clock, for tests. */
  now?: Date;
}

export interface CompleteIdempotencyInput {
  recordId: string;
  statusCode: number;
  body: Prisma.InputJsonValue;
  transactionId?: string;
  requestId?: string;
  expiresAt: Date;
}

export interface FinalizeTransactionInput {
  statusCode: number;
  body: Prisma.InputJsonValue;
  requestId?: string;
}

export type EnqueueOnceResult =
  | { enqueued: true; recordId: string }
  | { enqueued: false; reason: 'replayed'; response: IdempotentResponse }
  | { enqueued: false; reason: 'processing' };

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Reusable Idempotency-Key engine.
 *
 * Two layers are used together:
 * - **Redis** holds a short-lived in-progress lock so two concurrent duplicates
 *   are rejected fast with HTTP 409 (and a `Retry-After` hint).
 * - **Prisma** holds the durable `idempotency_records` row: the request hash,
 *   the completed response and the original request id, replayable for the
 *   configured TTL. The composite unique constraint on
 *   `(scope, route, keyHash)` arbitrates the winner across every replica.
 *
 * Keys are scoped by credential, principal and route, never by key alone, so
 * two credentials (or two routes) can use the same opaque key independently.
 * The raw key is never stored — only its SHA-256 digest.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /** Deterministic fingerprint of a normalized request body + path params. */
  fingerprint(body: unknown, params?: Record<string, unknown>): string {
    return computeRequestFingerprint({ body, params });
  }

  /**
   * Reserves the key at the HTTP boundary. Returns a handle whose `replay` is
   * set when an earlier completed response must be returned, otherwise the
   * caller executes the handler and calls `complete`/`fail`.
   */
  async begin(scope: IdempotencyScope): Promise<IdempotencyHandle> {
    const settings = this.settings();
    const keyHash = hashIdempotencyKey(scope.key);
    const requestHash = computeRequestFingerprint({ body: scope.requestBody });
    const identity: IdempotencyIdentity = {
      principalId: scope.principalId,
      scope: scope.scope ?? scope.principalId,
      route: scope.route,
      keyHash,
    };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.keyTtlMs);

    // Expired records are ignored and removed, so a key becomes reusable after
    // its retention window without a background job being required.
    await this.deleteExpiredFor(identity, now);

    const existing = await this.findRecord(identity);
    if (existing) return this.resolve(existing, requestHash);

    const lockKey = this.lockKey(identity);
    const lockToken = randomUUID();
    const lockAcquired = await this.acquireLock(lockKey, lockToken, settings.keyTtlMs);
    if (!lockAcquired) {
      const current = await this.findRecord(identity);
      if (current) return this.resolve(current, requestHash);
      throw new IdempotencyInFlightError(this.retryAfterSeconds(settings));
    }

    const reservation = await this.reserve({
      principalId: identity.principalId,
      scope: identity.scope,
      route: identity.route,
      key: scope.key,
      requestFingerprint: requestHash,
      expiresAt,
    });
    if (!reservation.created) {
      await this.releaseLock(lockKey, lockToken);
      return this.resolve(reservation.record, requestHash);
    }

    const recordId = reservation.record.id;
    return {
      complete: async (response: StoredIdempotentResponse) => {
        try {
          await this.complete({
            recordId,
            statusCode: response.statusCode,
            body: toJsonValue(response.body),
            requestId: response.requestId ?? undefined,
            expiresAt: new Date(Date.now() + settings.keyTtlMs),
          });
        } finally {
          await this.releaseLock(lockKey, lockToken);
        }
      },
      fail: async () => {
        try {
          await this.release(recordId);
        } finally {
          await this.releaseLock(lockKey, lockToken);
        }
      },
    };
  }

  /** Reserves a key, or returns the record that already holds it. */
  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<{ created: boolean; record: IdempotencyRecord }> {
    const now = input.now ?? new Date();
    const identity: IdempotencyIdentity = {
      principalId: input.principalId,
      scope: input.scope ?? input.principalId,
      route: input.route,
      keyHash: hashIdempotencyKey(input.key),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.deleteExpiredFor(identity, now);

      try {
        const record = await this.prisma.idempotencyRecord.create({
          data: {
            principalId: identity.principalId,
            scope: identity.scope,
            route: identity.route,
            keyHash: identity.keyHash,
            requestHash: input.requestFingerprint,
            expiresAt: input.expiresAt,
          },
        });
        return { created: true, record };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;

        const record = await this.findRecord(identity);
        if (!record) continue;

        // A record that failed (async terminal failure) or expired is reusable.
        if (record.status === 'FAILED' || record.expiresAt.getTime() <= now.getTime()) {
          await this.prisma.idempotencyRecord.deleteMany({
            where: { id: record.id },
          });
          continue;
        }

        return { created: false, record };
      }
    }

    // The row kept reappearing between the delete and the create (an extremely
    // unlikely delete/recreate race); report the conflict rather than looping.
    throw new ConflictException(
      'A concurrent request is using this Idempotency-Key; retry shortly',
    );
  }

  /** The cached response of a completed record, if it has one. */
  completedResponse(record: IdempotencyRecord): IdempotentResponse | undefined {
    if (record.status !== 'COMPLETED' || record.responseBody === null) return undefined;
    return {
      statusCode: record.responseStatus ?? 200,
      body: record.responseBody,
      requestId: record.requestId,
    };
  }

  /** Polls an in-flight record until it completes or the wait window elapses. */
  async waitForCompletion(
    recordId: string,
    waitTimeoutMs: number,
    pollIntervalMs: number,
  ): Promise<IdempotentResponse | undefined> {
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))),
      );
      const record = await this.prisma.idempotencyRecord.findUnique({
        where: { id: recordId },
      });
      if (!record) return undefined; // the original released the key
      const response = this.completedResponse(record);
      if (response) return response;
    }
    return undefined;
  }

  /** Links the record to the transaction it produced. */
  attachTransaction(recordId: string, transactionId: string): Promise<unknown> {
    return this.prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: { transactionId },
    });
  }

  /** Finalizes a record with the result the client will receive on replay. */
  async complete(input: CompleteIdempotencyInput): Promise<void> {
    await this.prisma.idempotencyRecord.update({
      where: { id: input.recordId },
      data: {
        status: 'COMPLETED',
        transactionId: input.transactionId,
        responseBody: input.body,
        responseStatus: input.statusCode,
        requestId: input.requestId,
        expiresAt: input.expiresAt,
      },
    });
  }

  /** Releases a reservation that never produced a transaction. */
  async release(recordId: string): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({
      where: { id: recordId, transactionId: null },
    });
  }

  /**
   * Finalizes the record of a transaction whose asynchronous processing reached
   * a terminal success. A keyless execution has no record, so this is a no-op.
   */
  async finalizeTransaction(
    transactionId: string,
    input: FinalizeTransactionInput,
  ): Promise<number> {
    const result = await this.prisma.idempotencyRecord.updateMany({
      where: { transactionId, status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        responseBody: input.body,
        responseStatus: input.statusCode,
        requestId: input.requestId,
      },
    });
    return result.count;
  }

  /**
   * Marks the record of a transaction that failed terminally. A later retry with
   * the same key is accepted: `reserve` treats FAILED records as reusable.
   */
  async failTransaction(transactionId: string): Promise<number> {
    const result = await this.prisma.idempotencyRecord.updateMany({
      where: { transactionId, status: 'PROCESSING' },
      data: { status: 'FAILED' },
    });
    return result.count;
  }

  deleteExpired(now = new Date()): Promise<{ count: number }> {
    return this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
  }

  /**
   * Applies the metadata of a replayed response to the current request, so the
   * success envelope returns the original status code and request id.
   */
  replay<T>(response: StoredIdempotentResponse): T {
    RequestContext.setData(IDEMPOTENT_REPLAY_STATUS, response.statusCode);
    if (response.requestId) {
      RequestContext.setData(IDEMPOTENT_REPLAY_REQUEST_ID, response.requestId);
    }
    RequestContext.setData(IDEMPOTENT_REPLAY, true);
    return response.body as T;
  }

  /**
   * Reserves a key and enqueues at most one job for it. Used by endpoints that
   * hand work to a BullMQ queue instead of executing it inline: the record is
   * written before `enqueue` runs, and a duplicate — concurrent or later — never
   * calls `enqueue` again.
   */
  async enqueueOnce(
    input: ReserveIdempotencyInput,
    enqueue: () => Promise<void>,
  ): Promise<EnqueueOnceResult> {
    const reservation = await this.reserve(input);
    if (!reservation.created) {
      if (reservation.record.requestHash !== input.requestFingerprint) {
        throw new DomainException(
          ErrorCode.IDEMPOTENCY_KEY_MISMATCH,
          'Idempotency-Key was already used with a different request payload',
        );
      }
      const response = this.completedResponse(reservation.record);
      return response
        ? { enqueued: false, reason: 'replayed', response }
        : { enqueued: false, reason: 'processing' };
    }

    try {
      await enqueue();
      return { enqueued: true, recordId: reservation.record.id };
    } catch (error) {
      await this.release(reservation.record.id);
      this.logger.warn(
        `Releasing idempotency key ${reservation.record.id}: enqueue failed (${(error as Error).message})`,
      );
      throw error;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private settings(): IdempotencyConfig {
    return this.config?.get<IdempotencyConfig>('idempotency') ?? idempotencyConfig();
  }

  private findRecord(identity: IdempotencyIdentity): Promise<IdempotencyRecord | null> {
    return this.prisma.idempotencyRecord.findUnique({
      where: {
        scope_route_keyHash: {
          scope: identity.scope,
          route: identity.route,
          keyHash: identity.keyHash,
        },
      },
    });
  }

  private deleteExpiredFor(identity: IdempotencyIdentity, now: Date): Promise<{ count: number }> {
    return this.prisma.idempotencyRecord.deleteMany({
      where: { ...identity, expiresAt: { lte: now } },
    });
  }

  /** Interprets an existing row for an HTTP request. */
  private resolve(record: IdempotencyRecord, requestHash: string): IdempotencyHandle {
    if (record.requestHash !== requestHash) {
      throw new IdempotencyMismatchError();
    }
    const replay = this.completedResponse(record);
    if (replay) {
      return {
        replay,
        // Replays never execute the handler, so there is nothing to persist.
        complete: async () => undefined,
        fail: async () => undefined,
      };
    }
    throw new IdempotencyInFlightError(this.retryAfterSeconds(this.settings()));
  }

  private retryAfterSeconds(settings: IdempotencyConfig): number {
    return Math.max(1, Math.ceil(settings.pollIntervalMs / 1_000));
  }

  private lockKey(identity: IdempotencyIdentity): string {
    return `idempotency:lock:${identity.scope}:${identity.route}:${identity.keyHash}`;
  }

  private async acquireLock(
    key: string,
    token: string,
    keyTtlMs: number,
  ): Promise<boolean> {
    if (!this.redis) return true; // the unique constraint still arbitrates
    const ttl = Math.max(MIN_LOCK_TTL_MS, keyTtlMs);
    const result = await this.redis.set(key, token, 'PX', ttl, 'NX');
    return result === 'OK';
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
    } catch (error) {
      // The lock expires on its own; never fail the request over cleanup.
      this.logger.warn(`Could not release idempotency lock: ${(error as Error).message}`);
    }
  }
}

/** Persist only JSON-serialisable response bodies. */
function toJsonValue(body: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(body ?? null)) as Prisma.InputJsonValue;
}

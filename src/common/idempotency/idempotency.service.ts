import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdempotencyRecord, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
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
import { stableStringify } from './stable-json.util';

const MIN_LOCK_TTL_MS = 30_000;

/** Compare-and-delete so a slow request cannot release another's lock. */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * Reusable Idempotency-Key engine.
 *
 * Two layers are used together:
 * - **Redis** holds a short-lived in-progress lock so two concurrent duplicates
 *   are rejected fast with HTTP 409 (and a `Retry-After` hint).
 * - **Prisma** holds the durable record: the request hash, the completed
 *   response and the original request id, replayable for the configured TTL.
 *
 * Keys are scoped by authenticated principal and route, never by key alone, so
 * two principals (or two routes) can use the same opaque key independently.
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionIdempotencyRecord } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConflictException } from '../exceptions/domain.exception';
import { RequestContext } from '../context/request-context';
import {
  IDEMPOTENT_REPLAY_REQUEST_ID,
  IDEMPOTENT_REPLAY_STATUS,
} from './idempotency.constants';
import { computeRequestFingerprint, hashIdempotencyKey } from './request-fingerprint';

/** Identity of an idempotency record: principal + route + key digest. */
export interface IdempotencyIdentity {
  principalId: string;
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
 * Reusable, Prisma-backed `Idempotency-Key` support.
 *
 * Callers reserve a key before doing any work. The composite unique constraint
 * on (principal, route, key digest) arbitrates concurrent requests across every
 * API replica: exactly one reservation is created, and every duplicate observes
 * the same record. The raw key is never stored — only its SHA-256 digest.
 *
 * Records are scoped by route, so the same key may be used independently on
 * different endpoints. Completed records replay the original status, body and
 * request id until they expire; a key reused with a different fingerprint is
 * rejected with 409. Failed or interrupted processing never blocks the key
 * forever: `release`/`failTransaction` free it, and expired rows are treated as
 * absent (and deleted) when the key is next used.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Deterministic fingerprint of a normalized request body + path params. */
  fingerprint(body: unknown, params?: Record<string, unknown>): string {
    return computeRequestFingerprint({ body, params });
  }

  /** Reserves a key, or returns the record that already holds it. */
  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<{ created: boolean; record: TransactionIdempotencyRecord }> {
    const now = input.now ?? new Date();
    const identity: IdempotencyIdentity = {
      principalId: input.principalId,
      route: input.route,
      keyHash: hashIdempotencyKey(input.key),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.prisma.transactionIdempotencyRecord.deleteMany({
        where: { ...identity, expiresAt: { lte: now } },
      });

      try {
        const record = await this.prisma.transactionIdempotencyRecord.create({
          data: {
            principalId: identity.principalId,
            // `operation` mirrors `route` so historical readers keep working.
            operation: identity.route,
            route: identity.route,
            keyHash: identity.keyHash,
            requestHash: input.requestFingerprint,
            expiresAt: input.expiresAt,
          },
        });
        return { created: true, record };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;

        const record = await this.prisma.transactionIdempotencyRecord.findUnique({
          where: {
            principalId_route_keyHash: {
              principalId: identity.principalId,
              route: identity.route,
              keyHash: identity.keyHash,
            },
          },
        });
        if (!record) continue;

        // A record that failed (async terminal failure) or expired is reusable.
        if (record.status === 'FAILED' || record.expiresAt.getTime() <= now.getTime()) {
          await this.prisma.transactionIdempotencyRecord.deleteMany({
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
  completedResponse(record: TransactionIdempotencyRecord): IdempotentResponse | undefined {
    if (record.status !== 'COMPLETED' || record.response === null) return undefined;
    return {
      statusCode: record.responseStatus ?? 200,
      body: record.response,
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
      const record = await this.prisma.transactionIdempotencyRecord.findUnique({
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
    return this.prisma.transactionIdempotencyRecord.update({
      where: { id: recordId },
      data: { transactionId },
    });
  }

  /** Finalizes a record with the result the client will receive on replay. */
  async complete(input: CompleteIdempotencyInput): Promise<void> {
    await this.prisma.transactionIdempotencyRecord.update({
      where: { id: input.recordId },
      data: {
        status: 'COMPLETED',
        transactionId: input.transactionId,
        response: input.body,
        responseStatus: input.statusCode,
        requestId: input.requestId,
        completedAt: new Date(),
        expiresAt: input.expiresAt,
      },
    });
  }

  /** Releases a reservation that never produced a transaction. */
  async release(recordId: string): Promise<void> {
    await this.prisma.transactionIdempotencyRecord.deleteMany({
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
    const result = await this.prisma.transactionIdempotencyRecord.updateMany({
      where: { transactionId, status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        response: input.body,
        responseStatus: input.statusCode,
        requestId: input.requestId,
        completedAt: new Date(),
      },
    });
    return result.count;
  }

  /**
   * Marks the record of a transaction that failed terminally. A later retry with
   * the same key is accepted: `reserve` treats FAILED records as reusable.
   */
  async failTransaction(transactionId: string): Promise<number> {
    const result = await this.prisma.transactionIdempotencyRecord.updateMany({
      where: { transactionId, status: 'PROCESSING' },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    return result.count;
  }

  deleteExpired(now = new Date()): Promise<{ count: number }> {
    return this.prisma.transactionIdempotencyRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
  }

  /**
   * Applies the metadata of a replayed response to the current request, so the
   * success envelope returns the original status code and request id.
   */
  replay<T>(response: IdempotentResponse): T {
    RequestContext.setData(IDEMPOTENT_REPLAY_STATUS, response.statusCode);
    if (response.requestId) {
      RequestContext.setData(IDEMPOTENT_REPLAY_REQUEST_ID, response.requestId);
    }
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
        throw new ConflictException(
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
}

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
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Reserves the key. Returns a handle whose `replay` is set when an earlier
   * completed response must be returned, otherwise the caller executes the
   * handler and calls `complete`/`fail`.
   */
  async begin(scope: IdempotencyScope): Promise<IdempotencyHandle> {
    const keyHash = sha256(scope.key);
    const requestHash = sha256(stableStringify(scope.requestBody));
    const identity = { principalId: scope.principalId, route: scope.route, keyHash };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.settings.keyTtlMs);

    // Expired records are ignored and removed, so a key becomes reusable after
    // its retention window without a background job being required.
    await this.prisma.idempotencyRecord.deleteMany({
      where: { ...identity, expiresAt: { lte: now } },
    });

    const existing = await this.findRecord(identity);
    if (existing) return this.resolve(existing, requestHash);

    const lockKey = `idempotency:lock:${identity.principalId}:${identity.route}:${keyHash}`;
    const lockToken = randomUUID();
    const lockAcquired = await this.acquireLock(lockKey, lockToken);
    if (!lockAcquired) {
      const current = await this.findRecord(identity);
      if (current) return this.resolve(current, requestHash);
      throw new IdempotencyInFlightError(this.retryAfterSeconds());
    }

    // Another worker may have completed the request between the first read and
    // the lock acquisition.
    const afterLock = await this.findRecord(identity);
    if (afterLock) {
      await this.releaseLock(lockKey, lockToken);
      return this.resolve(afterLock, requestHash);
    }

    let record: IdempotencyRecord;
    try {
      record = await this.prisma.idempotencyRecord.create({
        data: { ...identity, requestHash, status: 'PROCESSING', expiresAt },
      });
    } catch (error) {
      await this.releaseLock(lockKey, lockToken);
      if (isUniqueViolation(error)) {
        const current = await this.findRecord(identity);
        if (current) return this.resolve(current, requestHash);
      }
      throw error;
    }

    let settled = false;
    return {
      complete: async (response: StoredIdempotentResponse): Promise<void> => {
        if (settled) return;
        settled = true;
        try {
          await this.prisma.idempotencyRecord.update({
            where: { id: record.id },
            data: {
              status: 'COMPLETED',
              responseStatus: response.statusCode,
              responseBody: toJsonValue(response.body),
              requestId: response.requestId ?? null,
              expiresAt: new Date(Date.now() + this.settings.keyTtlMs),
            },
          });
        } catch (error) {
          // The operation already succeeded; never fail the response because
          // the replay record could not be written.
          this.logger.warn(
            `Could not persist idempotency response for ${scope.route}: ${(error as Error).message}`,
          );
        } finally {
          await this.releaseLock(lockKey, lockToken);
        }
      },
      fail: async (): Promise<void> => {
        if (settled) return;
        settled = true;
        try {
          await this.prisma.idempotencyRecord.deleteMany({
            where: { id: record.id, status: 'PROCESSING' },
          });
        } catch (error) {
          this.logger.warn(
            `Could not release idempotency key for ${scope.route}: ${(error as Error).message}`,
          );
        } finally {
          await this.releaseLock(lockKey, lockToken);
        }
      },
    };
  }

  private async resolve(
    record: IdempotencyRecord,
    requestHash: string,
  ): Promise<IdempotencyHandle> {
    if (record.requestHash !== requestHash) {
      throw new IdempotencyMismatchError();
    }
    if (record.status === 'COMPLETED' && record.responseBody !== null) {
      const replay: StoredIdempotentResponse = {
        statusCode: record.responseStatus ?? 200,
        body: record.responseBody,
        requestId: record.requestId,
      };
      return {
        replay,
        complete: async () => undefined,
        fail: async () => undefined,
      };
    }
    throw new IdempotencyInFlightError(this.retryAfterSeconds());
  }

  private findRecord(identity: {
    principalId: string;
    route: string;
    keyHash: string;
  }): Promise<IdempotencyRecord | null> {
    return this.prisma.idempotencyRecord.findUnique({
      where: { principalId_route_keyHash: identity },
    });
  }

  private async acquireLock(lockKey: string, token: string): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const result = await this.redis.set(
        lockKey,
        token,
        'PX',
        Math.max(MIN_LOCK_TTL_MS, this.settings.waitTimeoutMs + 10_000),
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      // Redis is a fast-path guard only: if it is unavailable, the durable
      // unique constraint still prevents two executions.
      this.logger.warn(`Idempotency lock unavailable: ${(error as Error).message}`);
      return true;
    }
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
    } catch (error) {
      this.logger.warn(`Could not release idempotency lock: ${(error as Error).message}`);
    }
  }

  private retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.settings.pollIntervalMs / 1_000));
  }

  private get settings(): IdempotencyConfig {
    return this.config?.get<IdempotencyConfig>('idempotency') ?? idempotencyConfig();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Normalises any handler return value into a JSON-safe Prisma value. */
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}


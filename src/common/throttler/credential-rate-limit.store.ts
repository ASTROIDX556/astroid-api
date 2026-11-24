import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { CredentialQuota } from './credential-quota';
import {
  CREDENTIAL_RATE_LIMIT_SCRIPT,
  CredentialRateLimitScriptResult,
} from './scripts/credential-rate-limit.lua';

/** Lengths of the two windows a credential is measured against. */
export interface CredentialRateLimitWindows {
  minuteWindowMs: number;
  dayWindowMs: number;
}

/** Outcome of counting one request against a credential's quota. */
export interface CredentialRateLimitDecision {
  allowed: boolean;
  /** Budget of the window closest to exhaustion. */
  limit: number;
  remaining: number;
  /** Epoch ms at which that window rolls over. */
  resetAt: number;
  /** Milliseconds until a blocked request could succeed again. */
  retryAfterMs: number;
  minuteHits: number;
  dayHits: number;
}

/**
 * Redis-backed credential counters shared by every API instance. Counting is
 * atomic (a single Lua script) and persisted, so limits hold across concurrent
 * requests, replicas and process restarts.
 */
export class RedisCredentialRateLimitStore {
  constructor(
    private readonly redis: Redis,
    private readonly testClock?: () => number,
  ) {}

  /** True when the client can serve commands right now without queueing. */
  get isReady(): boolean {
    return this.redis.status === 'ready';
  }

  async consume(
    identity: string,
    quota: CredentialQuota,
    windows: CredentialRateLimitWindows,
  ): Promise<CredentialRateLimitDecision> {
    const result = (await this.redis.eval(
      CREDENTIAL_RATE_LIMIT_SCRIPT,
      2,
      this.key(identity, 'minute'),
      this.key(identity, 'day'),
      quota.perMinute,
      windows.minuteWindowMs,
      quota.perDay,
      windows.dayWindowMs,
      randomUUID(),
      this.testClock?.() ?? 0,
    )) as CredentialRateLimitScriptResult;

    const [allowed, limit, remaining, resetAt, retryAfter, minuteHits, dayHits] = result;
    return {
      allowed: Number(allowed) === 1,
      limit: Number(limit),
      remaining: Number(remaining),
      resetAt: Number(resetAt),
      retryAfterMs: Number(retryAfter),
      minuteHits: Number(minuteHits),
      dayHits: Number(dayHits),
    };
  }

  private key(identity: string, window: 'minute' | 'day'): string {
    return `astroid:rate-limit:credential:${identity}:${window}`;
  }
}

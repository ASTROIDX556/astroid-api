import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { LockNotAcquiredException } from '../exceptions/domain.exception';
import { REDIS_CLIENT } from './locks.constants';

/**
 * The Lua script used to release a lock safely. It only deletes the key when
 * the value still matches the token this process holds, which prevents a
 * process from releasing a lock that already expired and was re-acquired by
 * another process. This is the canonical, race-free Redlock-style release.
 */
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/** Default lock lifetime in milliseconds (prevents deadlocks). */
export const DEFAULT_LOCK_TTL_MS = 5000;

/** A handle that releases the previously-acquired distributed lock. */
export type LockRelease = () => Promise<void>;

/**
 * Options controlling distributed lock acquisition and retry behaviour.
 * Retries use exponential backoff with jitter so that many contenders for the
 * same resource don't stampede Redis simultaneously.
 */
export interface LockAcquireOptions {
  /** Lock time to live in milliseconds. Prevents deadlocks if the holder crashes. */
  ttl?: number;
  /**
   * Number of additional acquisition attempts after the first (0 = fail fast).
   * Total attempts before giving up are `retries + 1`.
   */
  retries?: number;
  /** Base delay (ms) for exponential backoff between attempts. */
  baseDelayMs?: number;
  /** Cap on the per-attempt backoff delay (ms). */
  maxDelayMs?: number;
  /** Jitter factor (0–1) applied to the backoff delay. */
  jitterFactor?: number;
  /** Overall acquisition timeout (ms). Acquisition gives up past this deadline. */
  timeoutMs?: number;
}

const DEFAULT_RETRIES = 0;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_JITTER_FACTOR = 0.2;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Distributed lock service backed by a shared Redis instance.
 *
 * Uses the atomic `SET key token PX ttl NX` command to acquire a lock with a
 * TTL (so a crashed holder can never deadlock a resource), and releases it via
 * the {@link RELEASE_SCRIPT} Lua script so a lock is only released by the
 * process that actually holds it.
 *
 * When the lock is already held by another process, {@link acquire} and
 * {@link withLock} throw a {@link LockNotAcquiredException} (409), giving
 * callers a graceful, retryable conflict instead of a raw Redis failure.
 *
 * Acquisition supports either the positional `(ttl, attempts, retryDelayMs)`
 * form with a fixed delay between attempts, or a {@link LockAcquireOptions}
 * object with exponential backoff + jitter and an overall acquisition deadline.
 *
 * Usage:
 * ```
 * await redisLock.withLock(`agent:${id}`, () => this.repository.update(id, data));
 * ```
 */
@Injectable()
export class RedisLock implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  /**
   * Acquires a distributed lock with automatic expiration.
   *
   * @param key - Lock key (should be unique per resource).
   * @param arg - TTL in milliseconds, or a {@link LockAcquireOptions} object.
   * @param attempts - Number of acquisition attempts before giving up (>= 1).
   * @param retryDelayMs - Fixed delay between attempts in milliseconds.
   * @returns A {@link LockRelease} function that atomically releases the lock.
   * @throws LockNotAcquiredException when the lock cannot be acquired.
   */
  async acquire(
    key: string,
    arg: number | LockAcquireOptions = DEFAULT_LOCK_TTL_MS,
    attempts = 1,
    retryDelayMs = 100,
  ): Promise<LockRelease> {
    const opts: LockAcquireOptions =
      typeof arg === 'object'
        ? arg
        : { ttl: arg, retries: attempts - 1, baseDelayMs: retryDelayMs };

    const {
      ttl = DEFAULT_LOCK_TTL_MS,
      retries = DEFAULT_RETRIES,
      baseDelayMs = DEFAULT_BASE_DELAY_MS,
      maxDelayMs = DEFAULT_MAX_DELAY_MS,
      jitterFactor = DEFAULT_JITTER_FACTOR,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = opts;

    const lockKey = this.lockKey(key);
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    for (;;) {
      attempt++;
      // SET key token PX ttl NX — only sets when the key does not exist.
      const acquired = await this.redis.set(lockKey, token, 'PX', ttl, 'NX');

      if (acquired === 'OK') {
        return this.makeRelease(lockKey, token);
      }

      if (attempt > retries || Date.now() >= deadline) {
        throw new LockNotAcquiredException(key, { ttlMs: ttl, attempts: attempt });
      }

      const delay = this.backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Attempts to acquire a lock without throwing. Returns `null` when the lock
   * could not be acquired within the configured retries/timeout, allowing
   * callers to degrade gracefully. Mirrors {@link acquire}'s signature.
   */
  async tryAcquire(
    key: string,
    arg: number | LockAcquireOptions = DEFAULT_LOCK_TTL_MS,
    attempts = 1,
    retryDelayMs = 100,
  ): Promise<LockRelease | null> {
    try {
      return await this.acquire(key, arg, attempts, retryDelayMs);
    } catch {
      return null;
    }
  }

  /**
   * Executes a function while holding a distributed lock, releasing it in a
   * `finally` block even when the handler throws.
   *
   * @param key - Lock key.
   * @param fn - Handler executed while holding the lock.
   * @param ttl - Lock time to live in milliseconds, or a {@link LockAcquireOptions} object.
   * @param attempts - Number of acquisition attempts before giving up (>= 1).
   * @param retryDelayMs - Fixed delay between attempts in milliseconds.
   * @returns The result of {@link fn}.
   * @throws LockNotAcquiredException when the lock cannot be acquired.
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    arg: number | LockAcquireOptions = DEFAULT_LOCK_TTL_MS,
    attempts = 1,
    retryDelayMs = 100,
  ): Promise<T> {
    const release = await this.acquire(key, arg, attempts, retryDelayMs);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private lockKey(key: string): string {
    return `lock:${key}`;
  }

  private makeRelease(lockKey: string, token: string): LockRelease {
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
    };
  }

  private backoffDelay(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
    jitterFactor: number,
  ): number {
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
    const jitterRange = baseDelayMs * jitterFactor * attempt;
    const jitter = Math.random() * jitterRange;
    return Math.min(Math.floor(exponentialDelay + jitter), maxDelayMs);
  }
}

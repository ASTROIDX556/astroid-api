import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConfig } from '../../config/redis.config';

/**
 * Distributed lock utility using Redis.
 * Provides mutual exclusion for concurrent operations across multiple application instances.
 */
@Injectable()
export class RedisLock {
  private redis: Redis;

  constructor() {
    const config = redisConfig();
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
    });
  }

  /**
   * Acquires a distributed lock with automatic expiration.
   * @param key - Lock key (should be unique per resource)
   * @param ttl - Time to live in milliseconds (prevents deadlocks)
   * @returns Promise that resolves when lock is acquired, rejects if lock cannot be acquired
   */
  async acquire(key: string, ttl: number = 5000): Promise<LockRelease> {
    const lockKey = `lock:${key}`;
    const lockValue = Date.now().toString();

    // Try to acquire lock with SET NX EX
    const acquired = await this.redis.set(lockKey, lockValue, 'PX', ttl, 'NX');

    if (!acquired) {
      throw new Error(`Could not acquire lock for key: ${key}`);
    }

    // Return release function
    return async () => {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await this.redis.eval(script, 1, lockKey, lockValue);
    };
  }

  /**
   * Executes a function within a distributed lock.
   * @param key - Lock key
   * @param fn - Function to execute while holding the lock
   * @param ttl - Lock time to live in milliseconds
   * @returns Result of the function
   */
  async withLock<T>(key: string, fn: () => Promise<T>, ttl: number = 5000): Promise<T> {
    const release = await this.acquire(key, ttl);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

export type LockRelease = () => Promise<void>;

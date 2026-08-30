/**
 * DI token for the shared ioredis client used by the distributed locking
 * infrastructure. Provided by {@link LocksModule} as a singleton and consumed
 * by {@link RedisLock}.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

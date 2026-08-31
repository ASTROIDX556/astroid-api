import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisConfig } from '../../config/redis.config';
import { REDIS_CLIENT } from './locks.constants';
import { RedisLock } from './redis-lock.util';
import { AgentLockInterceptor } from './agent-lock.interceptor';
import { BudgetLockInterceptor } from './budget-lock.interceptor';
import { WalletLockInterceptor } from './wallet-lock.interceptor';
import { TransactionLockInterceptor } from './transaction-lock.interceptor';

/**
 * Global distributed-locking infrastructure.
 *
 * Provides a single shared ioredis client and the {@link RedisLock} service to
 * every module, and registers the {@link AgentLockInterceptor} and
 * {@link BudgetLockInterceptor} that enforce `@UseAgentLock()` and
 * `@UseBudgetLock()` on any decorated controller method.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { host, port, password, db } = config.getOrThrow<RedisConfig>('redis');
        return new Redis({ host, port, password, db });
      },
    },
    RedisLock,
    { provide: APP_INTERCEPTOR, useClass: AgentLockInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BudgetLockInterceptor },
    { provide: APP_INTERCEPTOR, useClass: WalletLockInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransactionLockInterceptor },
  ],
  exports: [REDIS_CLIENT, RedisLock],
})
export class LocksModule {}

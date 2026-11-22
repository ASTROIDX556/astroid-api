import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/**
 * Global idempotency infrastructure.
 *
 * `IdempotencyService` is shared by every module that applies `@Idempotent()`
 * to a mutating route. The Redis client and PrismaService are provided by the
 * global LocksModule and DatabaseModule.
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}

import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/** Prisma-backed idempotency support, shared by every execution endpoint. */
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}

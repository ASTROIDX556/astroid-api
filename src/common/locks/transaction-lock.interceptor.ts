import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable, throwError } from 'rxjs';
import { Request } from 'express';
import { RedisLock } from './redis-lock.util';
import { TRANSACTION_LOCK_KEY, TransactionLockOptions } from './transaction-lock.decorator';

/** Default TTL for transaction-level locks (longer than agent/budget locks). */
const TRANSACTION_LOCK_TTL_MS = 8000;

/** Default acquisition attempts for transaction locks (retries contention). */
const TRANSACTION_LOCK_ATTEMPTS = 3;

/** Default delay between retry attempts. */
const TRANSACTION_LOCK_RETRY_DELAY_MS = 50;

/**
 * Resolves a composite lock key from the transaction request body.
 * The key includes the wallet id (required) and budget id (optional) so that
 * concurrent transactions from the same wallet — even targeting different
 * budgets — are serialized, preventing double-spending.
 */
function defaultTransactionKeyResolver(request: Request): string {
  const body = request.body as Record<string, unknown> | undefined;
  const walletId = body?.walletId as string | undefined;
  if (!walletId) {
    throw new BadRequestException(
      'A walletId is required to acquire the transaction lock',
    );
  }
  const budgetId = body?.budgetId as string | undefined;
  return budgetId
    ? `transaction:${walletId}:${budgetId}`
    : `transaction:${walletId}`;
}

/**
 * Global interceptor enforcing `@UseTransactionLock()`. For handlers decorated
 * with the decorator it acquires a Redis distributed lock on the wallet
 * (optionally scoped to a budget) before invoking the handler and releases it
 * afterwards (including on error).
 *
 * This prevents concurrent transaction submissions from the same wallet across
 * multiple worker nodes, protecting against double-spending in a distributed
 * environment. The lock supports configurable retry attempts so transient
 * contention does not immediately fail the request.
 *
 * Handlers without the decorator pass straight through untouched.
 */
@Injectable()
export class TransactionLockInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redisLock: RedisLock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<TransactionLockOptions | undefined>(
      TRANSACTION_LOCK_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return next.handle();
    }

    try {
      const request = context.switchToHttp().getRequest<Request>();
      const resourceKey =
        typeof options.key === 'function'
          ? options.key(request)
          : options.key ?? defaultTransactionKeyResolver(request);
      const ttl = options.ttl ?? TRANSACTION_LOCK_TTL_MS;
      const attempts = options.attempts ?? TRANSACTION_LOCK_ATTEMPTS;
      const retryDelayMs = options.retryDelayMs ?? TRANSACTION_LOCK_RETRY_DELAY_MS;

      return from(
        this.redisLock.withLock(
          resourceKey,
          () => lastValueFrom(next.handle()),
          ttl,
          attempts,
          retryDelayMs,
        ),
      );
    } catch (error) {
      return throwError(() => error);
    }
  }
}

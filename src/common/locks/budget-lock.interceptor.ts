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
import { RedisLock, DEFAULT_LOCK_TTL_MS } from './redis-lock.util';
import { BUDGET_LOCK_KEY, BudgetLockOptions } from './budget-lock.decorator';

/**
 * Resolves the budget resource id from the request: `req.params.id` with a
 * fallback to `req.body.budgetId`.
 */
function defaultBudgetKeyResolver(request: Request): string {
  const params = request.params as { id?: string } | undefined;
  const body = request.body as { budgetId?: string } | undefined;
  const budgetId = params?.id ?? body?.budgetId;
  if (!budgetId) {
    throw new BadRequestException('A budget id is required to acquire the budget lock');
  }
  return `budget:${budgetId}`;
}

/**
 * Global interceptor enforcing `@UseBudgetLock()`. For handlers decorated with
 * the decorator it acquires a Redis distributed lock for the budget resource
 * before invoking the handler and releases it afterwards (including on error),
 * so concurrent mutations of the same budget are serialized across instances.
 *
 * Handlers without the decorator pass straight through untouched.
 */
@Injectable()
export class BudgetLockInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redisLock: RedisLock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<BudgetLockOptions | undefined>(BUDGET_LOCK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) {
      return next.handle();
    }

    try {
      const request = context.switchToHttp().getRequest<Request>();
      const resourceKey =
        typeof options.key === 'function'
          ? options.key(request)
          : options.key ?? defaultBudgetKeyResolver(request);
      const ttl = options.ttl ?? DEFAULT_LOCK_TTL_MS;

      return from(this.redisLock.withLock(resourceKey, () => lastValueFrom(next.handle()), ttl));
    } catch (error) {
      return throwError(() => error);
    }
  }
}

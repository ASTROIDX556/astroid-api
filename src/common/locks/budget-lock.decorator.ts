import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Request } from 'express';

/** Reflector metadata key used by {@link BudgetLockInterceptor}. */
export const BUDGET_LOCK_KEY = 'budgetLock';

export interface BudgetLockOptions {
  /**
   * Static lock key or a resolver producing the lock key from the incoming
   * request. Defaults to `budget:{params.id}`.
   */
  key?: string | ((request: Request) => string);
  /** Lock time-to-live in milliseconds (defaults to 5000). */
  ttl?: number;
}

/**
 * Decorator that serializes concurrent mutations on the same budget resource
 * by acquiring a Redis distributed lock around the handler.
 *
 * This prevents race conditions when multiple agents or requests simultaneously
 * attempt to allocate, deduct, or modify budgets — ensuring atomic
 * checks-and-balances for the same budget resource.
 *
 * Usage:
 * ```ts
 * @UseBudgetLock()
 * @Post(':id/allocate')
 * allocate(...) { ... }
 * ```
 *
 * When the lock cannot be acquired (another request is already mutating the
 * same budget), the request fails with a `409 LOCK_ACQUISITION_FAILED` error.
 */
export function UseBudgetLock(options: BudgetLockOptions = {}): MethodDecorator {
  return applyDecorators(SetMetadata(BUDGET_LOCK_KEY, options));
}

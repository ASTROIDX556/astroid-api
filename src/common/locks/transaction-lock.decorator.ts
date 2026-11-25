import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Request } from 'express';

/** Reflector metadata key used by {@link TransactionLockInterceptor}. */
export const TRANSACTION_LOCK_KEY = 'transactionLock';

export interface TransactionLockOptions {
  /**
   * Static lock key or a resolver producing the lock key from the incoming
   * request. Defaults to `transaction:{walletId}:{budgetId}` (budget component
   * is omitted when no budget is provided).
   */
  key?: string | ((request: Request) => string);
  /** Lock time-to-live in milliseconds (defaults to 8000). */
  ttl?: number;
  /**
   * Number of acquisition attempts before giving up (defaults to 3).
   * Higher values reduce contention failures at the cost of latency.
   */
  attempts?: number;
  /** Delay between retry attempts in milliseconds (defaults to 50). */
  retryDelayMs?: number;
}

/**
 * Decorator that serializes concurrent transaction submissions against the
 * same wallet (and optionally budget) by acquiring a Redis distributed lock
 * around the handler.
 *
 * This is the primary guard against double-spending: when two autonomous agents
 * or worker nodes attempt to submit transactions from the same wallet
 * simultaneously, the second request is rejected with a `409 LOCK_ACQUISITION_FAILED`
 * error rather than allowing both to proceed and potentially overdraft the wallet.
 *
 * The lock key defaults to the wallet id extracted from the request body
 * (`body.walletId`), with an optional budget component when `body.budgetId`
 * is present.
 *
 * Usage:
 * ```ts
 * @UseTransactionLock()
 * @Post()
 * create(...) { ... }
 * ```
 *
 * Options allow custom key resolvers, TTL, retry count, and retry delay for
 * fine-grained control over lock contention behaviour.
 */
export function UseTransactionLock(options: TransactionLockOptions = {}): MethodDecorator {
  return applyDecorators(SetMetadata(TRANSACTION_LOCK_KEY, options));
}

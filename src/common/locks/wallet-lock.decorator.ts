import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Request } from 'express';

/** Reflector metadata key used by {@link WalletLockInterceptor}. */
export const WALLET_LOCK_KEY = 'walletLock';

export interface WalletLockOptions {
  /**
   * Static lock key or a resolver producing the lock key from the incoming
   * request. Defaults to `wallet:{params.id ?? body.walletId}`.
   */
  key?: string | ((request: Request) => string);
  /** Lock time-to-live in milliseconds (defaults to 5000). */
  ttl?: number;
}

/**
 * Decorator that serializes concurrent state mutations on the same wallet
 * resource by acquiring a Redis distributed lock around the handler.
 *
 * This prevents double-spending race conditions when multiple agents or
 * requests simultaneously attempt to submit transactions from the same wallet,
 * ensuring only one mutation proceeds at a time per wallet.
 *
 * Usage:
 * ```ts
 * @UseWalletLock()
 * @Post()
 * create(...) { ... }
 * ```
 *
 * When the lock cannot be acquired (another request is already mutating the
 * same wallet), the request fails with a `409 LOCK_ACQUISITION_FAILED` error
 * rather than racing the other write.
 */
export function UseWalletLock(options: WalletLockOptions = {}): MethodDecorator {
  return applyDecorators(SetMetadata(WALLET_LOCK_KEY, options));
}

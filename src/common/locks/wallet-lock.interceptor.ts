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
import { WALLET_LOCK_KEY, WalletLockOptions } from './wallet-lock.decorator';

/**
 * Resolves the wallet resource id from the request: `req.params.id` (wallet
 * routes use `:id`) with a fallback to `req.body.walletId`.
 */
function defaultWalletKeyResolver(request: Request): string {
  const params = request.params as { id?: string } | undefined;
  const body = request.body as { walletId?: string } | undefined;
  const walletId = params?.id ?? body?.walletId;
  if (!walletId) {
    throw new BadRequestException('A wallet id is required to acquire the wallet lock');
  }
  return `wallet:${walletId}`;
}

/**
 * Global interceptor enforcing `@UseWalletLock()`. For handlers decorated with
 * the decorator it acquires a Redis distributed lock for the wallet resource
 * before invoking the handler and releases it afterwards (including on error),
 * so concurrent mutations of the same wallet are serialized across instances.
 *
 * Handlers without the decorator pass straight through untouched.
 */
@Injectable()
export class WalletLockInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redisLock: RedisLock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<WalletLockOptions | undefined>(WALLET_LOCK_KEY, [
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
          : options.key ?? defaultWalletKeyResolver(request);
      const ttl = options.ttl ?? DEFAULT_LOCK_TTL_MS;

      return from(this.redisLock.withLock(resourceKey, () => lastValueFrom(next.handle()), ttl));
    } catch (error) {
      return throwError(() => error);
    }
  }
}

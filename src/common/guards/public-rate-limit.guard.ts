import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Request, Response } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SKIP_PUBLIC_RATE_LIMIT_KEY } from '../decorators/skip-public-rate-limit.decorator';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { REDIS_CLIENT } from '../locks/locks.constants';
import {
  MemorySlidingWindowStore,
  RedisSlidingWindowStore,
  SlidingWindowHit,
} from '../throttler/sliding-window.store';
import { PublicRateLimitConfig, RateLimitConfig } from '../../config/rate-limit.config';
import { AppConfig } from '../../config/app.config';
import { getClientIp } from '../../utils/ip.util';

export const RATE_LIMIT_LIMIT_HEADER = 'X-RateLimit-Limit';
export const RATE_LIMIT_REMAINING_HEADER = 'X-RateLimit-Remaining';
export const RATE_LIMIT_RESET_HEADER = 'X-RateLimit-Reset';

/**
 * IP-based sliding-window rate limiter for unauthenticated endpoints, the
 * first line of defence against burst traffic and resource exhaustion.
 *
 * Applies to every route marked `@Public()` and to every route under
 * `/<API_PREFIX>/public/`, unless exempted with `@SkipPublicRateLimit()`.
 * Authenticated routes are left to the per-organization throttlers.
 *
 * Every limited response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`
 * and `X-RateLimit-Reset` (epoch seconds at which a slot frees up); rejected
 * requests get `429 Too Many Requests` plus `Retry-After`.
 *
 * Counters live in Redis (the shared `REDIS_CLIENT`) so every replica enforces
 * one budget per IP. If Redis is unavailable the guard falls back to a
 * per-process in-memory window rather than failing open, so public endpoints
 * stay protected during an outage.
 *
 * Implemented as a guard rather than Express middleware because middleware
 * runs before routing and cannot see the `@Public()` metadata.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PublicRateLimitGuard.name);
  private readonly settings: PublicRateLimitConfig;
  private readonly publicPathPrefix: string;
  private readonly redisStore: RedisSlidingWindowStore;
  private readonly fallbackStore = new MemorySlidingWindowStore();
  private usingFallback = false;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.settings = config.getOrThrow<RateLimitConfig>('rateLimit').public;
    const apiPrefix = config.get<AppConfig>('app')?.apiPrefix ?? '';
    this.publicPathPrefix = `/${[apiPrefix, 'public'].join('/')}`.replace(/\/{2,}/g, '/');
    this.redisStore = new RedisSlidingWindowStore(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.settings.enabled || context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!this.appliesTo(context, request)) {
      return true;
    }

    const response = context.switchToHttp().getResponse<Response>();
    const { maxRequests: limit, windowSeconds } = this.settings;
    const now = Date.now();
    const key = `rate-limit:public:ip:${this.clientIp(request)}`;
    const hit = await this.record(key, limit, windowSeconds * 1000, now);

    response.setHeader(RATE_LIMIT_LIMIT_HEADER, limit);
    response.setHeader(RATE_LIMIT_REMAINING_HEADER, Math.max(0, limit - hit.count));
    response.setHeader(RATE_LIMIT_RESET_HEADER, Math.ceil(hit.resetAt / 1000));

    if (!hit.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
      response.setHeader('Retry-After', retryAfterSeconds);
      throw new DomainException(
        ErrorCode.RATE_LIMITED,
        'Too many requests from this IP address. Please retry later.',
        { limit, windowSeconds, retryAfterSeconds },
      );
    }

    return true;
  }

  private appliesTo(context: ExecutionContext, request: Request): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_PUBLIC_RATE_LIMIT_KEY, targets)) {
      return false;
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const path = request.path ?? '';
    return path === this.publicPathPrefix || path.startsWith(`${this.publicPathPrefix}/`);
  }

  /** Records the hit in Redis, degrading to the in-memory window on outage. */
  private async record(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<SlidingWindowHit> {
    if (this.redisStore.isReady) {
      try {
        const hit = await this.redisStore.hit(key, limit, windowMs, now);
        if (this.usingFallback) {
          this.usingFallback = false;
          this.logger.log('Redis is reachable again; public rate limits are shared across instances.');
        }
        return hit;
      } catch (error) {
        this.enterFallback(`Redis rate-limit check failed: ${(error as Error).message}`);
      }
    } else {
      this.enterFallback('Redis is not ready');
    }
    return this.fallbackStore.hit(key, limit, windowMs, now);
  }

  private enterFallback(reason: string): void {
    if (!this.usingFallback) {
      this.usingFallback = true;
      this.logger.warn(`${reason}; enforcing public rate limits per instance in memory.`);
    }
  }

  private clientIp(request: Request): string {
    const forwarded = request.headers?.['x-forwarded-for'];
    const forwardedFor = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    return getClientIp(ip, forwardedFor, this.settings.trustProxy);
  }
}

import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { REDIS_CLIENT } from '../locks/locks.constants';
import {
  RedisSlidingWindowStore,
  SlidingWindowHit,
  SlidingWindowStore,
} from '../throttler/sliding-window.store';
import {
  SENSITIVE_RATE_LIMIT_KEY,
  SENSITIVE_ROUTE_POLICY,
  SensitiveRoute,
} from '../throttler/sensitive-route-policy';
import { RateLimitConfig, SensitiveRouteLimit } from '../../config/rate-limit.config';
import { getClientIp } from '../../utils/ip.util';
import {
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
} from './public-rate-limit.guard';

/**
 * Redis-backed sliding-window limit for the routes that issue credentials or
 * re-point webhooks: login, token refresh, API-key creation, webhook creation
 * and webhook secret rotation. Applied per route with `@SensitiveRateLimit()`,
 * never globally, so normal agent traffic and the health probes are untouched.
 *
 * Each route keeps its own budget (`rateLimit.sensitive.<route>`), counted per
 * caller: the client IP before authentication, the authenticated API key or
 * user after it (see `SENSITIVE_ROUTE_POLICY`).
 *
 * Exceeding the limit answers 429 `RATE_LIMITED` with `Retry-After` and the
 * standard problem-details body. When Redis cannot be used, credential routes
 * fail closed (503 `RATE_LIMIT_UNAVAILABLE`) and management routes fail open
 * with a warning.
 */
@Injectable()
export class SensitiveRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(SensitiveRateLimitGuard.name);
  private readonly limits: Record<SensitiveRoute, SensitiveRouteLimit>;
  private readonly trustProxy: boolean;
  private readonly store: SlidingWindowStore & { readonly isReady: boolean };

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    const rateLimit = config.getOrThrow<RateLimitConfig>('rateLimit');
    this.limits = rateLimit.sensitive;
    this.trustProxy = rateLimit.public.trustProxy;
    this.store = new RedisSlidingWindowStore(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.getAllAndOverride<SensitiveRoute | undefined>(
      SENSITIVE_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!route || context.getType() !== 'http') {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const limit = this.limits[route];
    const now = Date.now();

    const hit = await this.record(route, this.bucketKey(route, request), limit, now);
    if (!hit) {
      return true;
    }

    response.setHeader(RATE_LIMIT_LIMIT_HEADER, limit.maxRequests);
    response.setHeader(RATE_LIMIT_REMAINING_HEADER, Math.max(0, limit.maxRequests - hit.count));
    response.setHeader(RATE_LIMIT_RESET_HEADER, Math.ceil(hit.resetAt / 1000));

    if (!hit.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
      response.setHeader('Retry-After', retryAfterSeconds);
      throw new DomainException(
        ErrorCode.RATE_LIMITED,
        'Too many requests to this endpoint. Please retry later.',
        { limit: limit.maxRequests, windowSeconds: limit.windowSeconds, retryAfterSeconds },
      );
    }
    return true;
  }

  /**
   * Counts the request, or applies the route's failure mode when Redis cannot be
   * used. Returns `undefined` when the request is let through unlimited.
   */
  private async record(
    route: SensitiveRoute,
    key: string,
    limit: SensitiveRouteLimit,
    now: number,
  ): Promise<SlidingWindowHit | undefined> {
    let reason = 'Redis is not ready';
    if (this.store.isReady) {
      try {
        return await this.store.hit(key, limit.maxRequests, limit.windowSeconds * 1000, now);
      } catch (error) {
        reason = `Redis rate-limit check failed: ${(error as Error).message}`;
      }
    }

    if (SENSITIVE_ROUTE_POLICY[route].failureMode === 'closed') {
      this.logger.error(`${reason}; refusing "${route}" (fails closed).`);
      throw new DomainException(
        ErrorCode.RATE_LIMIT_UNAVAILABLE,
        'This endpoint is temporarily unavailable. Please retry shortly.',
      );
    }

    this.logger.warn(`${reason}; allowing "${route}" without a rate limit (fails open).`);
    return undefined;
  }

  /** `rate-limit:sensitive:<route>:<caller>`, with the caller chosen by the route's policy. */
  private bucketKey(route: SensitiveRoute, request: Request & { user?: AuthenticatedUser }): string {
    const principal =
      SENSITIVE_ROUTE_POLICY[route].identity === 'principal' ? this.principal(request) : undefined;
    return `rate-limit:sensitive:${route}:${principal ?? `ip:${this.clientIp(request)}`}`;
  }

  private principal(request: Request & { user?: AuthenticatedUser }): string | undefined {
    const user = request.user;
    if (!user) return undefined;
    if (user.isApiKey) return `apikey:${user.apiKeyId ?? user.id}`;
    const subject = user.sub ?? user.id;
    return subject ? `user:${subject}` : undefined;
  }

  private clientIp(request: Request): string {
    const forwarded = request.headers?.['x-forwarded-for'];
    const forwardedFor = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    return getClientIp(ip, forwardedFor, this.trustProxy);
  }
}

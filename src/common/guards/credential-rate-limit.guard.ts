import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Response } from 'express';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import {
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
  RETRY_AFTER_HEADER,
} from '../constants/headers';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { SKIP_CREDENTIAL_RATE_LIMIT_KEY } from '../decorators/skip-credential-rate-limit.decorator';
import {
  CredentialQuota,
  CredentialQuotaCache,
  CredentialRequest,
  quotaFromRequest,
  withDefaults,
} from '../throttler/credential-quota';
import {
  CredentialRateLimitWindows,
  RedisCredentialRateLimitStore,
} from '../throttler/credential-rate-limit.store';
import { CredentialRateLimitConfig, RateLimitConfig } from '../../config/rate-limit.config';
import { getClientIp } from '../../utils/ip.util';

/**
 * Per-credential quota guard, registered globally **after** authentication so
 * the counter is keyed by the verified API key id (never by a raw key or by an
 * unverified header). JWT callers are counted per user and anonymous callers
 * fall back to their client IP.
 *
 * Every request is measured against two Redis-backed windows — requests per
 * minute and requests per day — with per-key overrides taken from the
 * authenticated key (`rateLimitPerMinute` / `rateLimitPerDay`) and defaults from
 * `rateLimit.credential`. Counting is atomic and shared by every replica.
 *
 * Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
 * `X-RateLimit-Reset` for the window closest to exhaustion; exceeding a window
 * answers 429 `RATE_LIMITED` with `Retry-After` and the standard problem-details
 * body. Health/readiness and metrics are exempt via
 * `@SkipCredentialRateLimit()`.
 *
 * Failure policy: **fail open**. If Redis is unreachable the request is allowed
 * and a warning is logged — the tier throttler and the public/sensitive
 * limiters keep their own policies, and turning a Redis outage into a full API
 * outage would be a worse trade for general traffic.
 */
@Injectable()
export class CredentialRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(CredentialRateLimitGuard.name);
  private readonly defaults: CredentialRateLimitConfig;
  private readonly windows: CredentialRateLimitWindows;
  private readonly trustProxy: boolean;
  private readonly store: RedisCredentialRateLimitStore;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
    @Inject(REDIS_CLIENT) redis: Redis,
    private readonly quotaCache: CredentialQuotaCache,
  ) {
    const rateLimit = config.getOrThrow<RateLimitConfig>('rateLimit');
    this.defaults = rateLimit.credential;
    this.trustProxy = rateLimit.public.trustProxy;
    this.windows = {
      minuteWindowMs: rateLimit.credential.minuteWindowSeconds * 1000,
      dayWindowMs: rateLimit.credential.dayWindowSeconds * 1000,
    };
    this.store = new RedisCredentialRateLimitStore(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const exempt = this.reflector.getAllAndOverride<boolean>(SKIP_CREDENTIAL_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<CredentialRequest>();
    const response = http.getResponse<Response>();
    const credentialId = this.credentialId(request);
    // Authenticated JWT/dashboard traffic is not part of the API-key quota.
    // Anonymous/public routes retain the existing IP fallback quota.
    const user = request.user;
    if (user?.isApiKey === false || (user && !user.isApiKey)) {
      return true;
    }
    const identity = credentialId
      ? `apikey:${credentialId}`
      : this.userIdentity(request) ?? `ip:${this.clientIp(request)}`;
    const quota = await this.resolveQuota(request, credentialId);

    let decision;
    try {
      if (!this.store.isReady) {
        throw new Error('Redis is not ready');
      }
      decision = await this.store.consume(identity, quota, this.windows);
    } catch (error) {
      this.logger.warn(
        `Credential rate-limit check failed for "${identity}"; allowing request (fails open): ${(error as Error).message}`,
      );
      this.setFailOpenHeaders(response, quota);
      return true;
    }

    response.setHeader(RATE_LIMIT_LIMIT_HEADER, decision.limit);
    response.setHeader(RATE_LIMIT_REMAINING_HEADER, decision.remaining);
    response.setHeader(RATE_LIMIT_RESET_HEADER, Math.ceil(decision.resetAt / 1000));
    response.setHeader('RateLimit-Limit', decision.limit);
    response.setHeader('RateLimit-Remaining', decision.remaining);
    response.setHeader('RateLimit-Reset', Math.ceil(decision.resetAt / 1000));

    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      response.setHeader(RETRY_AFTER_HEADER, retryAfterSeconds);
      throw new DomainException(
        ErrorCode.RATE_LIMITED,
        'Rate limit exceeded for this credential. Please retry later.',
        {
          limit: decision.limit,
          retryAfterSeconds,
          resetAt: new Date(decision.resetAt).toISOString(),
        },
      );
    }
    return true;
  }

  /** Best-effort minute-budget headers when Redis cannot provide exact counters. */
  private setFailOpenHeaders(response: Response, quota: CredentialQuota): void {
    const now = Date.now();
    const resetAt = now + this.windows.minuteWindowMs;
    response.setHeader(RATE_LIMIT_LIMIT_HEADER, quota.perMinute);
    response.setHeader(RATE_LIMIT_REMAINING_HEADER, quota.perMinute);
    response.setHeader(RATE_LIMIT_RESET_HEADER, Math.ceil(resetAt / 1000));
  }

  /** Verified API key id, when the caller authenticated with one. */
  private credentialId(request: CredentialRequest): string | undefined {
    if (request.apiKey?.id) {
      return request.apiKey.id;
    }
    const user = request.user;
    return user?.isApiKey ? (user.apiKeyId ?? user.id) : undefined;
  }

  private userIdentity(request: CredentialRequest): string | undefined {
    const subject = request.user?.sub ?? request.user?.id;
    return subject ? `user:${subject}` : undefined;
  }

  private async resolveQuota(
    request: CredentialRequest,
    credentialId: string | undefined,
  ): Promise<CredentialQuota> {
    const overrides = quotaFromRequest(request);
    if (overrides) {
      const quota = withDefaults(overrides, this.defaults);
      if (credentialId) {
        this.quotaCache.remember(credentialId, quota);
      }
      return quota;
    }
    if (credentialId) {
      const cached = await this.quotaCache.read(credentialId);
      if (cached) {
        return withDefaults(cached, this.defaults);
      }
    }
    return withDefaults(undefined, this.defaults);
  }

  private clientIp(request: CredentialRequest): string {
    const forwarded = request.headers?.['x-forwarded-for'];
    const forwardedFor = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    return getClientIp(ip, forwardedFor, this.trustProxy);
  }
}

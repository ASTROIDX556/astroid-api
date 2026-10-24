import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';
import { extractApiKeyFromRequest } from '../helpers/extract-api-key';
import { resolveRequestAgentId } from '../helpers/resolve-agent-id';

export const SLIDING_WINDOW_LIMIT_KEY = 'astroid:slidingWindowLimit';
export const SlidingWindowLimit = (limit: number, windowSeconds = 60) =>
  Reflector.createDecorator<{ limit: number; windowSeconds: number }>()({ limit, windowSeconds });

/**
 * Redis-backed sliding-window rate limiter for the high-frequency routes
 * (transaction submission, agent commands, webhook ingress).
 *
 * The window is a Redis sorted set per client and route: every request adds a
 * member scored with its timestamp, expired members are pruned on the next
 * request, and the whole update runs inside a `MULTI`/`EXEC` transaction so
 * concurrent requests cannot slip past the limit.
 *
 * Clients are bucketed by the acting agent first, then by the API key, the
 * organization and finally the client IP. Bucketing per agent keeps a single
 * misbehaving agent from exhausting the budget of every other agent of the
 * same organization.
 *
 * Exceeding the limit answers with HTTP 429 and a `Retry-After` header that
 * points at the moment the oldest request leaves the window.
 */
@Injectable()
export class SlidingWindowThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(SlidingWindowThrottlerGuard.name);
  private readonly redis: Redis;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.defaultLimit = config.get<number>('rateLimit.maxRequests', 120);
    this.defaultWindowSeconds = config.get<number>('rateLimit.windowSeconds', 60);
    const host = config.get<string>('redis.host', 'localhost');
    const port = config.get<number>('redis.port', 6379);
    const password = config.get<string>('redis.password', '');
    const db = config.get<number>('redis.db', 0);
    this.redis = new Redis({ host, port, password: password || undefined, db, lazyConnect: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse<Response>();
    const configured = this.reflector.getAllAndOverride<{ limit: number; windowSeconds: number }>(
      SLIDING_WINDOW_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    let limit = configured?.limit ?? this.defaultLimit;
    const windowSeconds = configured?.windowSeconds ?? this.defaultWindowSeconds;

    const userTier =
      (request.user as (AuthenticatedUser & { tier?: string }) | undefined)?.tier ??
      (request as Request & { apiKey?: { tier?: string } }).apiKey?.tier;
    if (userTier === 'enterprise') {
      limit = Math.max(limit, 500);
    } else if (userTier === 'pro') {
      limit = Math.max(limit, 250);
    } else if (userTier === 'free' || userTier === 'standard') {
      limit = Math.min(limit, 100);
    }

    const key = this.keyFor(request, context);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    response.setHeader('X-RateLimit-Limit', limit);
    response.setHeader('X-RateLimit-Reset', Math.ceil((now + windowSeconds * 1000) / 1000));

    try {
      const member = `${now}:${Math.random().toString(36).slice(2)}`;
      // One atomic transaction: prune the expired members, count what is left,
      // record the new request and read the oldest member (the one whose slot
      // frees up first). The count is taken before the insert, so the limit
      // allows exactly `limit` requests per window.
      const result = await this.redis
        .multi()
        .zremrangebyscore(key, 0, windowStart)
        .zcard(key)
        .zadd(key, now, member)
        .expire(key, windowSeconds)
        .zrange(key, 0, 0, 'WITHSCORES')
        .exec();
      const entries = (result ?? []) as unknown as Array<[Error | null, unknown]>;
      const count = Number(entries[1]?.[1] ?? 0);
      const remaining = Math.max(0, limit - count - 1);
      response.setHeader('X-RateLimit-Remaining', remaining);
      if (count >= limit) {
        response.setHeader('Retry-After', this.retryAfterSeconds(entries[4]?.[1], now, windowSeconds));
        throw new DomainException(ErrorCode.RATE_LIMITED, 'Rate limit exceeded', {
          limit,
          windowSeconds,
        });
      }
      return true;
    } catch (error) {
      if (error instanceof DomainException && error.code === ErrorCode.RATE_LIMITED) throw error;
      this.logger.error(
        `Sliding-window Redis check failed; allowing request: ${(error as Error).message}`,
      );
      response.setHeader('X-RateLimit-Remaining', limit);
      return true;
    }
  }

  /**
   * Seconds until the next request is accepted: the oldest member of the
   * window leaves it after `windowSeconds`, at which point a slot frees up.
   */
  private retryAfterSeconds(
    oldestScore: unknown,
    now: number,
    windowSeconds: number,
  ): number {
    const oldest = Number(oldestScore ?? 0);
    if (!Number.isFinite(oldest) || oldest <= 0) {
      return Math.max(1, windowSeconds);
    }
    return Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000));
  }

  private keyFor(
    request: Request & { user?: AuthenticatedUser },
    context: ExecutionContext,
  ): string {
    const scope = this.clientScope(request);
    const tier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';
    return `rate-limit:${tier}:${scope}:${context.getClass().name}:${context.getHandler().name}`;
  }

  /**
   * Identifies the client for rate-limit bucketing. The acting agent comes
   * first so one agent cannot exhaust the budget of the other agents of the
   * same organization; then the authenticated API key, the organization and
   * finally the client IP for fully unauthenticated routes. A raw API key is
   * never stored — it is hashed.
   */
  private clientScope(request: Request & { user?: AuthenticatedUser }): string {
    const agentId = resolveRequestAgentId(request);
    if (agentId) {
      return `agent:${agentId}`;
    }

    if (request.user?.isApiKey) {
      return `key:${request.user.apiKeyId ?? request.user.id}`;
    }

    const organizationId = request.user?.organizationId;
    if (organizationId) {
      return `org:${organizationId}`;
    }

    const apiKey = extractApiKeyFromRequest(request);
    if (apiKey) {
      return `key:${createHash('sha256').update(apiKey).digest('hex')}`;
    }

    const forwarded = request.headers?.['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.ip ?? 'anonymous';
    return `ip:${ip}`;
  }
}

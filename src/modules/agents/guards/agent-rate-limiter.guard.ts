import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Request, Response } from 'express';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';
import { AgentService } from '../agent.service';

@Injectable()
export class AgentRateLimiterGuard implements CanActivate {
  private readonly logger = new Logger(AgentRateLimiterGuard.name);
  private readonly redis: Redis;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds = 60;
  private readonly cacheTtlSeconds = 300;

  constructor(config: ConfigService, private readonly agentService: AgentService) {
    this.defaultLimit = config.get<number>('rateLimit.agentExecutions', 5);
    const host = config.get<string>('redis.host', 'localhost');
    const port = config.get<number>('redis.port', 6379);
    const password = config.get<string>('redis.password', '');
    const db = config.get<number>('redis.db', 0);
    this.redis = new Redis({ host, port, password: password || undefined, db, lazyConnect: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: { organizationId?: string } }>();
    const response = context.switchToHttp().getResponse<Response>();
    
    const rawAgentId = request.params?.id;
    const agentId = Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId;
    if (!agentId || typeof agentId !== 'string') return true;

    const organizationId = request.user?.organizationId;
    if (!organizationId || typeof organizationId !== 'string') return true;

    let limit = this.defaultLimit;
    const windowSeconds = this.defaultWindowSeconds;

    const cacheKey = `rate_limit_config:agent:${agentId}`;
    const cachedLimit = await this.redis.get(cacheKey);
    
    if (cachedLimit !== null) {
      limit = parseInt(cachedLimit, 10);
    } else {
      try {
        const agent = await this.agentService.getOrThrow(organizationId, agentId);
        const metadata = agent.metadata as Record<string, unknown> | null;
        if (metadata && typeof metadata.rateLimit === 'number') {
          limit = metadata.rateLimit;
        } else if (
          metadata &&
          typeof metadata.rateLimit === 'object' &&
          metadata.rateLimit !== null &&
          'limit' in metadata.rateLimit &&
          typeof (metadata.rateLimit as { limit: unknown }).limit === 'number'
        ) {
          limit = (metadata.rateLimit as { limit: number }).limit;
        }
        await this.redis.set(cacheKey, limit, 'EX', this.cacheTtlSeconds);
      } catch (err) {
        this.logger.warn(`Could not fetch agent ${agentId} for rate limit threshold: ${(err as Error).message}`);
      }
    }

    const key = `rate_limit:agent:${agentId}:${windowSeconds}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    response.setHeader('X-RateLimit-Limit', limit);
    response.setHeader('X-RateLimit-Reset', Math.ceil((now + windowSeconds * 1000) / 1000));

    try {
      const member = `${now}:${Math.random().toString(36).slice(2)}`;
      // One atomic transaction: prune the expired members, count what is left,
      // record the new request and read the oldest member (the one whose slot
      // frees up first).
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
        throw new DomainException(ErrorCode.RATE_LIMITED, 'Agent rate limit exceeded', { limit, windowSeconds });
      }
      return true;
    } catch (error) {
      if (error instanceof DomainException && error.code === ErrorCode.RATE_LIMITED) throw error;
      this.logger.error(`Agent rate limit Redis check failed; allowing request: ${(error as Error).message}`);
      response.setHeader('X-RateLimit-Remaining', limit);
      return true;
    }
  }

  /**
   * Seconds until the next request is accepted: the oldest member of the
   * window leaves it after `windowSeconds`, at which point a slot frees up.
   */
  private retryAfterSeconds(oldestScore: unknown, now: number, windowSeconds: number): number {
    const oldest = Number(oldestScore ?? 0);
    if (!Number.isFinite(oldest) || oldest <= 0) {
      return Math.max(1, windowSeconds);
    }
    return Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000));
  }
}

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
import { AGENT_LOCK_KEY, AgentLockOptions } from './agent-lock.decorator';

/**
 * Resolves the agent resource id from the request: `req.params.id` (agent
 * routes use `:id`) with a fallback to `req.body.agentId`.
 */
function defaultAgentKeyResolver(request: Request): string {
  const params = request.params as { id?: string } | undefined;
  const body = request.body as { agentId?: string } | undefined;
  const agentId = params?.id ?? body?.agentId;
  if (!agentId) {
    throw new BadRequestException('An agent id is required to acquire the agent lock');
  }
  return `agent:${agentId}`;
}

/**
 * Global interceptor enforcing `@UseAgentLock()`. For handlers decorated with
 * the decorator it acquires a Redis distributed lock for the agent resource
 * before invoking the handler and releases it afterwards (including on error),
 * so concurrent mutations of the same agent are serialized across instances.
 *
 * Handlers without the decorator pass straight through untouched.
 */
@Injectable()
export class AgentLockInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redisLock: RedisLock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<AgentLockOptions | undefined>(AGENT_LOCK_KEY, [
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
          : options.key ?? defaultAgentKeyResolver(request);
      const ttl = options.ttl ?? DEFAULT_LOCK_TTL_MS;

      return from(this.redisLock.withLock(resourceKey, () => lastValueFrom(next.handle()), ttl));
    } catch (error) {
      return throwError(() => error);
    }
  }
}

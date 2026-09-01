import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Request } from 'express';

/** Reflector metadata key used by {@link AgentLockInterceptor}. */
export const AGENT_LOCK_KEY = 'agentLock';

export interface AgentLockOptions {
  /**
   * Static lock key or a resolver producing the lock key from the incoming
   * request. Defaults to `agent:{params.id ?? body.agentId}`.
   */
  key?: string | ((request: Request) => string);
  /** Lock time-to-live in milliseconds (defaults to 5000). */
  ttl?: number;
}

/**
 * Decorator that serializes concurrent state mutations on the same agent
 * resource by acquiring a Redis distributed lock around the handler.
 *
 * Usage:
 * ```
 * @UseAgentLock()
 * @Patch(':id')
 * update(@Param('id') id: string, @Body() body: UpdateAgentInput) { ... }
 * ```
 *
 * When the lock cannot be acquired (another request is already mutating the
 * same agent), the request fails with a `409 LOCK_ACQUISITION_FAILED` error
 * rather than racing the other write.
 */
export function UseAgentLock(options: AgentLockOptions = {}): MethodDecorator {
  return applyDecorators(SetMetadata(AGENT_LOCK_KEY, options));
}

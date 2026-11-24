import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { AgentLockInterceptor } from './agent-lock.interceptor';
import { RedisLock } from './redis-lock.util';
import { AGENT_LOCK_KEY, AgentLockOptions } from './agent-lock.decorator';
import { LockNotAcquiredException } from '../exceptions/domain.exception';

function buildContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
}

const handler = (): void => {};
class Controller {}

function decorate(options: AgentLockOptions | undefined): void {
  if (options === undefined) {
    Reflect.deleteMetadata(AGENT_LOCK_KEY, handler);
    return;
  }
  Reflect.defineMetadata(AGENT_LOCK_KEY, options, handler);
}

describe('AgentLockInterceptor', () => {
  let reflector: Reflector;
  let redisLock: { withLock: ReturnType<typeof vi.fn> };
  let interceptor: AgentLockInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteMetadata(AGENT_LOCK_KEY, handler);
    reflector = new Reflector();
    redisLock = {
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    };
    interceptor = new AgentLockInterceptor(reflector, redisLock as unknown as RedisLock);
  });

  it('passes through when the handler is not decorated with @UseAgentLock()', async () => {
    decorate(undefined);
    const ctx = buildContext({ params: { id: 'agent-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    const result = await interceptor.intercept(ctx, next).toPromise();

    expect(result).toBe('ok');
    expect(redisLock.withLock).not.toHaveBeenCalled();
  });

  it('acquires a lock on the default agent key for decorated handlers', async () => {
    decorate({});
    const ctx = buildContext({ params: { id: 'agent-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('agent:agent-1', expect.any(Function), 5000);
  });

  it('supports a custom static lock key', async () => {
    decorate({ key: 'agent:custom' });
    const ctx = buildContext({ params: { id: 'agent-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('agent:custom', expect.any(Function), 5000);
  });

  it('supports a custom key resolver function receiving the request', async () => {
    const resolver = vi.fn().mockReturnValue('agent:resolved');
    decorate({ key: resolver });
    const req = { params: { id: 'agent-1' } };
    const ctx = buildContext(req);
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(resolver).toHaveBeenCalledWith(req);
    expect(redisLock.withLock).toHaveBeenCalledWith('agent:resolved', expect.any(Function), 5000);
  });

  it('falls back to body.agentId when no route param is present', async () => {
    decorate({});
    const ctx = buildContext({ params: {}, body: { agentId: 'agent-9' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('agent:agent-9', expect.any(Function), 5000);
  });

  it('uses the configured ttl when provided', async () => {
    decorate({ ttl: 250 });
    const ctx = buildContext({ params: { id: 'agent-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('agent:agent-1', expect.any(Function), 250);
  });

  it('rejects the request when the agent id cannot be resolved', async () => {
    decorate({});
    const ctx = buildContext({ params: {}, body: {} });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toThrow('agent id');
    expect(redisLock.withLock).not.toHaveBeenCalled();
  });

  it('propagates lock acquisition failures to the caller', async () => {
    decorate({});
    redisLock.withLock.mockRejectedValue(new LockNotAcquiredException('agent-1'));
    const ctx = buildContext({ params: { id: 'agent-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toBeInstanceOf(
      LockNotAcquiredException,
    );
  });

  it('propagates handler errors through the lock boundary', async () => {
    decorate({});
    const ctx = buildContext({ params: { id: 'agent-1' } });
    const next = { handle: () => throwError(() => new Error('boom')) } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toThrow('boom');
    expect(redisLock.withLock).toHaveBeenCalledWith('agent:agent-1', expect.any(Function), 5000);
  });
});

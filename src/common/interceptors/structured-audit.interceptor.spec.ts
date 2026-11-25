import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';

import { StructuredAuditInterceptor } from './structured-audit.interceptor';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator';
import { IS_SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import { TraceContext } from '../context/trace.context';

interface MockRequest {
  method: string;
  path: string;
  originalUrl: string;
  url: string;
  body: Record<string, unknown>;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: { id: string; organizationId: string };
}

function buildMockContext(overrides: {
  request?: Partial<MockRequest>;
  statusCode?: number;
} = {}): ExecutionContext {
  const request: MockRequest = {
    method: 'POST',
    path: '/api/v1/agents',
    originalUrl: '/api/v1/agents',
    url: '/api/v1/agents',
    body: { name: 'Procurement Bot' },
    params: {},
    query: {},
    headers: { 'user-agent': 'TestAgent/1.0' },
    ip: '127.0.0.1',
    user: { id: 'user-1', organizationId: 'org-1' },
    ...overrides.request,
  };

  const response = { statusCode: overrides.statusCode ?? 201 };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => vi.fn(),
    getClass: () => class AgentController {},
  } as unknown as ExecutionContext;
}

function buildCallHandler(returnValue: unknown = { id: 'agent-1' }): CallHandler {
  return { handle: () => of(returnValue) };
}

function buildErrorCallHandler(error: Error): CallHandler {
  return { handle: () => throwError(() => error) };
}

/** Reflector stub that answers the two metadata keys the interceptor reads. */
function makeReflector(stub: { action?: unknown; skip?: boolean }): Reflector {
  return {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === AUDIT_ACTION_KEY) return stub.action;
      if (key === IS_SKIP_AUDIT_KEY) return stub.skip;
      return undefined;
    }),
  } as unknown as Reflector;
}

describe('StructuredAuditInterceptor', () => {
  let eventBus: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
  });

  function build(
    overrides: { action?: unknown; skip?: boolean } = {},
  ): StructuredAuditInterceptor {
    const action = Object.prototype.hasOwnProperty.call(overrides, 'action')
      ? overrides.action
      : { action: 'AGENT_CREATED' };
    return new StructuredAuditInterceptor(
      makeReflector({ action, skip: overrides.skip }),
      eventBus as unknown as EventBusService,
    );
  }

  it('does not publish an event for routes without @AuditAction()', async () => {
    const subject = build({ action: undefined });
    const context = buildMockContext();

    await subject.intercept(context, buildCallHandler()).toPromise();

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('publishes an audit.recorded event with the request metadata', async () => {
    const subject = build({ action: { action: 'AGENT_CREATED', entity: 'Agent' } });
    const context = buildMockContext({ statusCode: 201 });

    await subject.intercept(context, buildCallHandler()).toPromise();

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    const [name, payload, options] = eventBus.emit.mock.calls[0];

    expect(name).toBe(DomainEventName.AuditRecorded);
    expect(payload).toEqual(
      expect.objectContaining({
        action: 'AGENT_CREATED',
        entity: 'Agent',
        method: 'POST',
        url: '/api/v1/agents',
        statusCode: 201,
        success: true,
        userId: 'user-1',
        organizationId: 'org-1',
        ipAddress: '127.0.0.1',
        userAgent: 'TestAgent/1.0',
      }),
    );
    expect(payload.occurredAt).toEqual(expect.any(String));
    expect(payload.durationMs).toEqual(expect.any(Number));
    expect(options).toEqual(
      expect.objectContaining({
        organizationId: 'org-1',
        actorId: 'user-1',
        aggregateType: 'Agent',
      }),
    );
  });

  it('never publishes sensitive material such as private keys or JWTs', async () => {
    const subject = build({ action: { action: 'AGENT_CREATED' } });
    const context = buildMockContext({
      request: {
        body: {
          name: 'Bot',
          privateKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
          apiKey: 'sk-0123456789abcdefghij',
          nested: { secret: 'super-secret' },
        },
        query: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij' },
      },
    });

    await subject.intercept(context, buildCallHandler()).toPromise();

    const payload = eventBus.emit.mock.calls[0][1];
    expect(payload.body.privateKey).toBe('[REDACTED]');
    expect(payload.body.apiKey).toBe('[REDACTED]');
    expect(payload.body.nested.secret).toBe('[REDACTED]');
    expect(payload.body.name).toBe('Bot');
    expect(JSON.stringify(payload)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('skips routes that opted out with @SkipAudit()', async () => {
    const subject = build({ action: { action: 'AGENT_CREATED' }, skip: true });
    const context = buildMockContext();

    await subject.intercept(context, buildCallHandler()).toPromise();

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('records the status code of a failed operation', async () => {
    const subject = build({ action: { action: 'AGENT_CREATED' } });
    const context = buildMockContext({ statusCode: 200 });

    await subject
      .intercept(context, buildErrorCallHandler(new BadRequestException('nope')))
      .toPromise()
      .catch(() => undefined);

    const payload = eventBus.emit.mock.calls[0][1];
    expect(payload.statusCode).toBe(400);
    expect(payload.success).toBe(false);
  });

  it('captures the acting agent from the ambient trace context', async () => {
    const subject = build({ action: { action: 'AGENT_CREATED' } });
    const context = buildMockContext();

    await TraceContext.run({ traceId: 'req_trace-abc-123', agentId: 'agent-88' }, () =>
      subject.intercept(context, buildCallHandler()).toPromise(),
    );

    const payload = eventBus.emit.mock.calls[0][1];
    expect(payload.agentId).toBe('agent-88');
    expect(payload.requestId).toBe('req_trace-abc-123');
  });

  it('does not block the response cycle on the audit publication', async () => {
    let resolveEmit: (() => void) | undefined;
    eventBus.emit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEmit = resolve;
        }),
    );
    const subject = build({ action: { action: 'AGENT_CREATED' } });
    const context = buildMockContext();

    const result = await subject.intercept(context, buildCallHandler()).toPromise();

    expect(result).toEqual({ id: 'agent-1' });
    expect(eventBus.emit).toHaveBeenCalledTimes(1);

    resolveEmit?.();
  });

  it('never lets a failing event bus break the request', async () => {
    eventBus.emit = vi.fn().mockRejectedValue(new Error('bus down'));
    const subject = build({ action: { action: 'AGENT_CREATED' } });
    const context = buildMockContext();

    await expect(subject.intercept(context, buildCallHandler()).toPromise()).resolves.toEqual({
      id: 'agent-1',
    });
  });
});

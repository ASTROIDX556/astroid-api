import { describe, it, expect } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { AgentTraceInterceptor } from './agent-trace.interceptor';
import { TraceContext } from '../context/trace.context';

describe('AgentTraceInterceptor', () => {
  const interceptor = new AgentTraceInterceptor();

  it('should initialize and propagate trace context through execution', async () => {
    let capturedTraceId: string | undefined;
    let capturedAgentId: string | undefined;
    let capturedOrgId: string | undefined;

    const mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            'x-correlation-id': 'custom-trace-123',
            'x-agent-id': 'agent-uuid-456',
          },
          params: { agentId: 'agent-uuid-456' },
          body: {},
          query: {},
          user: { id: 'user-789', organizationId: 'org-abc' },
          path: '/api/v1/agents/agent-uuid-456/execute',
          method: 'POST',
        }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => {
        capturedTraceId = TraceContext.getTraceId();
        capturedAgentId = TraceContext.getAgentId();
        capturedOrgId = TraceContext.getOrganizationId();
        return of({ success: true });
      },
    };

    const observable = interceptor.intercept(mockExecutionContext, mockCallHandler);

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: () => resolve(),
        error: (err) => reject(err),
      });
    });

    expect(capturedTraceId).toBe('custom-trace-123');
    expect(capturedAgentId).toBe('agent-uuid-456');
    expect(capturedOrgId).toBe('org-abc');
  });

  it('should generate a trace ID when none is provided in headers', async () => {
    let capturedTraceId: string | undefined;

    const mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          params: {},
          body: {},
          query: {},
          user: { id: 'user-1', organizationId: 'org-1' },
          path: '/api/v1/status',
          method: 'GET',
        }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => {
        capturedTraceId = TraceContext.getTraceId();
        return of({ ok: true });
      },
    };

    const observable = interceptor.intercept(mockExecutionContext, mockCallHandler);

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: () => resolve(),
        error: (err) => reject(err),
      });
    });

    expect(capturedTraceId).toBeDefined();
    expect(typeof capturedTraceId).toBe('string');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { AUDIT_LOG_KEY } from '../decorators/audit-log.decorator';

function context(metadata: unknown, request: Record<string, unknown>, response = { statusCode: 201 }) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(metadata) };
  const executionContext = {
    getHandler: vi.fn(), getClass: vi.fn().mockReturnValue(class TestController {}),
    switchToHttp: vi.fn().mockReturnValue({ getRequest: () => request, getResponse: () => response }),
  };
  return { reflector, executionContext };
}

describe('AuditLogInterceptor', () => {
  it('passes undecorated handlers through without recording', () => {
    const { reflector, executionContext } = context(undefined, {});
    const service = { record: vi.fn() };
    const interceptor = new AuditLogInterceptor(reflector as never, service as never);
    interceptor.intercept(executionContext as never, { handle: () => of('ok') });
    expect(service.record).not.toHaveBeenCalled();
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(AUDIT_LOG_KEY, expect.any(Array));
  });

  it('sanitizes nested sensitive fields and persists success asynchronously', async () => {
    vi.useFakeTimers();
    const { executionContext } = context({ action: 'KEY_ROTATION', entity: 'agent', entityIdParam: 'id' }, {
      params: { id: 'agent-1' }, body: { password: 'secret', nested: { privateKey: 'key', safe: true } },
      user: { id: 'user-1', organizationId: 'org-1' }, ip: '127.0.0.1', get: () => 'Vitest',
    });
    const service = { record: vi.fn().mockResolvedValue(undefined) };
    const interceptor = new AuditLogInterceptor({ getAllAndOverride: vi.fn().mockReturnValue({ action: 'KEY_ROTATION', entity: 'agent', entityIdParam: 'id' }) } as never, service as never);
    interceptor.intercept(executionContext as never, { handle: () => of('ok') }).subscribe();
    await vi.runAllTimersAsync();
    expect(service.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'KEY_ROTATION', entityId: 'agent-1', newValue: expect.objectContaining({ body: { password: '[REDACTED]', nested: { privateKey: '[REDACTED]', safe: true } }, status: 201 }) }));
    vi.useRealTimers();
  });

  it('records failed requests with their HTTP status', async () => {
    vi.useFakeTimers();
    const { executionContext } = context({ action: 'DELETE', entity: 'agent' }, { body: {}, user: { id: 'user-1', organizationId: 'org-1' }, get: () => undefined });
    const service = { record: vi.fn().mockResolvedValue(undefined) };
    const interceptor = new AuditLogInterceptor({ getAllAndOverride: vi.fn().mockReturnValue({ action: 'DELETE', entity: 'agent' }) } as never, service as never);
    interceptor.intercept(executionContext as never, { handle: () => throwError(() => ({ status: 403 })) }).subscribe({ error: () => undefined });
    await vi.runAllTimersAsync();
    expect(service.record).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ status: 403 }) }));
    vi.useRealTimers();
  });

  it('does not persist without an authenticated organization', async () => {
    vi.useFakeTimers();
    const { executionContext } = context({ action: 'UPDATE' }, { body: {}, user: { id: 'user-1' } });
    const service = { record: vi.fn() };
    const interceptor = new AuditLogInterceptor({ getAllAndOverride: vi.fn().mockReturnValue({ action: 'UPDATE' }) } as never, service as never);
    interceptor.intercept(executionContext as never, { handle: () => of('ok') }).subscribe();
    await vi.runAllTimersAsync();
    expect(service.record).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

import { EventEmitter } from 'events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionContext, Logger } from '@nestjs/common';
import { of } from 'rxjs';

import { AuditService } from '../../modules/audit/audit.service';
import {
  AuditLogInterceptor,
  isSensitiveKey,
  maskSensitiveData,
  REDACTED_VALUE,
} from './audit-log.interceptor';

/** Stand-ins for real controllers so entity resolution can be asserted. */
class PolicyController {}
class WalletController {}

type MockRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  ip?: string;
  user?: { id: string; organizationId: string; email: string; role: string };
};

function createMockResponse(statusCode = 200): EventEmitter & { statusCode: number } {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode;
  return response;
}

function createContext(
  request: MockRequest,
  response: EventEmitter & { statusCode: number },
  controller: new () => unknown = PolicyController,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

/** Subscribes so the handler runs, emits `finish`, then waits for the async audit write. */
async function runRequest(
  interceptor: AuditLogInterceptor,
  context: ReturnType<typeof createContext>,
  response: EventEmitter & { statusCode: number },
): Promise<void> {
  const observable = interceptor.intercept(context, {
    handle: () => of({ success: true }),
  });
  await new Promise<void>((resolve, reject) => {
    observable.subscribe({ next: () => resolve(), error: reject });
  });
  response.emit('finish');
  // Let the fire-and-forget audit write settle (it only awaits resolved promises).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeInterceptor(record: ReturnType<typeof vi.fn>, trustProxy = false): AuditLogInterceptor {
  const auditService = { record } as unknown as AuditService;
  const config = { get: vi.fn().mockReturnValue(trustProxy) } as never;
  return new AuditLogInterceptor(auditService, config);
}

describe('AuditLogInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('payload extraction', () => {
    it('captures user id, method, path, client IP, body and response status code', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record, true);

      const request: MockRequest = {
        method: 'PATCH',
        path: '/api/v1/policies/pol-123',
        headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.5' },
        params: { id: 'pol-123' },
        query: {},
        body: { name: 'Daily limit', configuration: { maxAmount: 100 } },
        ip: '::1',
        user: { id: 'user-1', organizationId: 'org-1', email: 'admin@example.com', role: 'ADMIN' },
      };
      const response = createMockResponse(201);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          userId: 'user-1',
          action: 'PATCH',
          entity: 'Policy',
          entityId: 'pol-123',
          ipAddress: '203.0.113.5',
          device: 'test-agent',
          newValue: {
            path: '/api/v1/policies/pol-123',
            body: { name: 'Daily limit', configuration: { maxAmount: 100 } },
            statusCode: 201,
          },
        }),
      );
    });

    it('captures agent identity and defaults to the socket IP when no proxy header is trusted', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record, false);

      const request: MockRequest = {
        method: 'POST',
        path: '/api/v1/wallets/wal-1/rotate',
        headers: { 'user-agent': 'AgentRunner/1.0', 'x-agent-id': 'agent-9' },
        params: { id: 'wal-1' },
        query: {},
        body: { agentId: 'agent-9', newLabel: 'ops' },
        ip: '10.0.0.7',
        user: { id: 'user-2', organizationId: 'org-2', email: 'a@b.com', role: 'DEVELOPER' },
      };
      const response = createMockResponse(200);
      const context = createContext(request, response, WalletController);

      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-2',
          action: 'POST',
          entity: 'Wallet',
          ipAddress: '10.0.0.7',
          newValue: expect.objectContaining({ agentId: 'agent-9', statusCode: 200 }),
        }),
      );
    });
  });

  describe('sensitive data masking', () => {
    it('redacts sensitive fields, preserves non-sensitive ones and does not mutate the original body', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const originalBody = {
        username: 'john',
        password: 'secret-pass',
        apiKey: 'abc123',
        token: 'jwt-token',
        passkey: 'cred-1',
        webhook: { signature: 'sig-here', url: 'https://example.com/hook' },
        nested: { refreshToken: 'rt-1', note: 'keep me' },
      };
      const request: MockRequest = {
        method: 'PUT',
        path: '/api/v1/developer/keys',
        headers: { 'user-agent': 'test' },
        params: {},
        query: {},
        body: originalBody,
        ip: '127.0.0.1',
        user: { id: 'user-1', organizationId: 'org-1', email: 'a@b.com', role: 'ADMIN' },
      };
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      const { newValue } = record.mock.calls[0][0];
      expect(newValue.body).toEqual({
        username: 'john',
        password: REDACTED_VALUE,
        apiKey: REDACTED_VALUE,
        token: REDACTED_VALUE,
        passkey: REDACTED_VALUE,
        webhook: { signature: REDACTED_VALUE, url: 'https://example.com/hook' },
        nested: { refreshToken: REDACTED_VALUE, note: 'keep me' },
      });
      // The original request body must be untouched.
      expect(originalBody).toEqual({
        username: 'john',
        password: 'secret-pass',
        apiKey: 'abc123',
        token: 'jwt-token',
        passkey: 'cred-1',
        webhook: { signature: 'sig-here', url: 'https://example.com/hook' },
        nested: { refreshToken: 'rt-1', note: 'keep me' },
      });
    });

    it('masks sensitive keys case-insensitively and across separators', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('PasswordHash')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('x-api-key')).toBe(true);
      expect(isSensitiveKey('accessToken')).toBe(true);
      expect(isSensitiveKey('passkey')).toBe(true);
      expect(isSensitiveKey('signature')).toBe(true);
      expect(isSensitiveKey('privateKey')).toBe(true);
      expect(isSensitiveKey('username')).toBe(false);
      expect(isSensitiveKey('name')).toBe(false);
      expect(isSensitiveKey('amount')).toBe(false);
    });

    it('masks sensitive entries inside arrays', () => {
      const masked = maskSensitiveData([
        { label: 'primary', apiKey: 'abc' },
        { label: 'backup', apiKey: 'def' },
      ]);
      expect(masked).toEqual([
        { label: 'primary', apiKey: REDACTED_VALUE },
        { label: 'backup', apiKey: REDACTED_VALUE },
      ]);
    });
  });

  describe('audit failure handling', () => {
    it('does not crash the request when audit persistence fails and logs the error', async () => {
      const loggerError = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const record = vi.fn().mockRejectedValue(new Error('database unreachable'));
      const interceptor = makeInterceptor(record);

      const request: MockRequest = {
        method: 'DELETE',
        path: '/api/v1/policies/pol-1',
        headers: { 'user-agent': 'test' },
        params: { id: 'pol-1' },
        query: {},
        body: {},
        ip: '127.0.0.1',
        user: { id: 'user-1', organizationId: 'org-1', email: 'a@b.com', role: 'ADMIN' },
      };
      const response = createMockResponse(204);
      const context = createContext(request, response);

      // Must resolve — the failed audit write must not surface to the caller.
      await runRequest(interceptor, context, response);

      expect(record).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write audit log for DELETE Policy'),
      );
    });
  });

  describe('scope filtering', () => {
    it('does not audit read-only GET requests', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request: MockRequest = {
        method: 'GET',
        path: '/api/v1/policies',
        headers: { 'user-agent': 'test' },
        params: {},
        query: {},
        body: {},
        ip: '127.0.0.1',
        user: { id: 'user-1', organizationId: 'org-1', email: 'a@b.com', role: 'ADMIN' },
      };
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).not.toHaveBeenCalled();
    });

    it('skips requests without an organization context (e.g. public routes)', async () => {
      const record = vi.fn().mockResolvedValue(undefined);
      const interceptor = makeInterceptor(record);

      const request: MockRequest = {
        method: 'POST',
        path: '/api/v1/auth/login',
        headers: { 'user-agent': 'test' },
        params: {},
        query: {},
        body: { email: 'a@b.com', password: 'secret' },
        ip: '127.0.0.1',
      };
      const response = createMockResponse(200);
      const context = createContext(request, response);

      await runRequest(interceptor, context, response);

      expect(record).not.toHaveBeenCalled();
    });
  });
});

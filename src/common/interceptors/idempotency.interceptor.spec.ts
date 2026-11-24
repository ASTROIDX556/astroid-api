import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';
import { z } from 'zod';
import { ErrorCode } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import { IDEMPOTENT_REPLAY_HEADER } from '../constants/headers';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import {
  IdempotencyInFlightError,
  IdempotencyMismatchError,
} from '../idempotency/idempotency.types';

function contextFor(options: {
    headers?: Record<string, string>;
    body?: unknown;
    isMultipart?: boolean;
    user?: { id?: string; isApiKey?: boolean; apiKeyId?: string };
  } = {}) {
  const response = {
    status: vi.fn(),
    setHeader: vi.fn(),
    getHeader: vi.fn().mockReturnValue('req-original'),
    statusCode: 201,
  };
  const request = {
    headers: options.headers ?? { 'idempotency-key': 'key-abc-1' },
    method: 'POST',
    baseUrl: '/api/v1',
    path: '/transactions',
    body: options.body ?? { amount: '10' },
    user: options.user ?? { id: 'user-1' },
    is: vi.fn().mockReturnValue(options.isMultipart === true),
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { context, response, request };
}

describe('IdempotencyInterceptor', () => {
  let reflector: Reflector;
  let service: { begin: ReturnType<typeof vi.fn>; replay: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    reflector = new Reflector();
    service = { begin: vi.fn(), replay: vi.fn((response: { body: unknown }) => response.body) };
  });

  function interceptor(): IdempotencyInterceptor {
    return new IdempotencyInterceptor(reflector, service as never);
  }

  it('bypasses when the handler is not decorated', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const { context } = contextFor();
    const next = { handle: vi.fn().mockReturnValue(of({ ok: true })) };

    await expect(lastValueFrom(await interceptor().intercept(context, next))).resolves.toEqual({ ok: true });
    expect(service.begin).not.toHaveBeenCalled();
  });

  it('preserves existing behaviour when no key is supplied', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    const { context } = contextFor({ headers: {} });
    const next = { handle: vi.fn().mockReturnValue(of({ ok: true })) };

    await expect(lastValueFrom(await interceptor().intercept(context, next))).resolves.toEqual({ ok: true });
    expect(service.begin).not.toHaveBeenCalled();
  });

  it('rejects a key outside the 8-255 character window', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    const { context } = contextFor({ headers: { 'idempotency-key': 'short' } });

    await expect(interceptor().intercept(context, { handle: vi.fn() })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('trims the key before using it and tolerates a custom header name', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    service.begin.mockResolvedValue({ complete: vi.fn(), fail: vi.fn() });
    const config = {
      get: vi.fn().mockReturnValue({ headerName: 'X-Job-Key' }),
    };
    const { context } = contextFor({
      headers: { 'x-job-key': '  key-abc-1  ', 'idempotency-key': 'ignored-key' },
    });
    const next = { handle: vi.fn().mockReturnValue(of({ ok: true })) };
    const custom = new IdempotencyInterceptor(reflector, service as never, config as never);

    await lastValueFrom(await custom.intercept(context, next));

    expect(service.begin).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'key-abc-1', scope: 'user:user-1' }),
    );
  });

  it('scopes API-key credentials separately from users with the same id', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    service.begin.mockResolvedValue({ complete: vi.fn(), fail: vi.fn() });
    const { context } = contextFor({ user: { id: 'same-id', isApiKey: true, apiKeyId: 'key-1' } });
    const next = { handle: vi.fn().mockReturnValue(of({ ok: true })) };

    await lastValueFrom(await interceptor().intercept(context, next));

    expect(service.begin).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'same-id', scope: 'apikey:key-1' }),
    );
  });

  it('fingerprints the parsed body when the handler declares a schema', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? { bodySchema: z.object({ amount: z.string().default('0') }) } : undefined,
    );
    service.begin.mockResolvedValue({ complete: vi.fn(), fail: vi.fn() });
    const { context } = contextFor({ body: {} });
    const next = { handle: vi.fn().mockReturnValue(of({ ok: true })) };

    await lastValueFrom(await interceptor().intercept(context, next));

    expect(service.begin).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { amount: '0' } }),
    );
  });

  it('excludes multipart requests', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    const { context } = contextFor({ isMultipart: true });
    const next = { handle: vi.fn().mockReturnValue(of({ ok: true })) };

    await lastValueFrom(await interceptor().intercept(context, next));
    expect(service.begin).not.toHaveBeenCalled();
  });

  it('replays the stored response including the original request id', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    service.begin.mockResolvedValue({
      replay: { statusCode: 201, body: { id: 'tx-1' }, requestId: 'req-original' },
    });
    const { context, response, request } = contextFor();
    const next = { handle: vi.fn() };

    const result = await lastValueFrom(await interceptor().intercept(context, next));

    expect(result).toEqual({ id: 'tx-1' });
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.setHeader).toHaveBeenCalledWith(IDEMPOTENT_REPLAY_HEADER, 'true');
    expect(response.setHeader).toHaveBeenCalledWith('x-request-id', 'req-original');
    expect((request.headers as Record<string, string>)['x-request-id']).toBe('req-original');
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('executes once and persists status, body and request id', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    const complete = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn();
    service.begin.mockResolvedValue({ complete, fail });
    const { context } = contextFor();
    const next = { handle: vi.fn().mockReturnValue(of({ id: 'tx-1' })) };

    const result = await lastValueFrom(await interceptor().intercept(context, next));

    expect(result).toEqual({ id: 'tx-1' });
    expect(complete).toHaveBeenCalledWith({
      statusCode: 201,
      body: { id: 'tx-1' },
      requestId: 'req-original',
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it('persists the router default 201 for POST when Nest has not applied it yet', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    const complete = vi.fn().mockResolvedValue(undefined);
    service.begin.mockResolvedValue({ complete, fail: vi.fn() });
    const { context, response } = contextFor();
    response.statusCode = 200;
    const next = { handle: vi.fn().mockReturnValue(of({ id: 'tx-1' })) };

    await lastValueFrom(await interceptor().intercept(context, next));

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 201 }));
  });

  it('releases the key when the handler fails so a 5xx can be retried', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    const fail = vi.fn().mockResolvedValue(undefined);
    service.begin.mockResolvedValue({ complete: vi.fn(), fail });
    const { context } = contextFor();
    const next = {
      handle: vi.fn().mockReturnValue({
        subscribe: (observer: { error: (error: Error) => void }) => observer.error(new Error('boom')),
      }),
    };

    await expect(lastValueFrom(await interceptor().intercept(context, next))).rejects.toThrow('boom');
    expect(fail).toHaveBeenCalled();
  });

  it('returns 409 with Retry-After and a stable code for an in-flight duplicate', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    service.begin.mockRejectedValue(new IdempotencyInFlightError(2));
    const { context, response } = contextFor();

    const error = await interceptor().intercept(context, { handle: vi.fn() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getStatus()).toBe(409);
    expect((error as DomainException).code).toBe(ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '2');
  });

  it('returns 422 with a stable code when the key is reused with a different body', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === 'idempotent_request' ? {} : undefined,
    );
    service.begin.mockRejectedValue(new IdempotencyMismatchError());
    const { context } = contextFor();

    const error = await interceptor().intercept(context, { handle: vi.fn() }).catch((caught: unknown) => caught);
    expect((error as DomainException).getStatus()).toBe(422);
    expect((error as DomainException).code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH);
  });
});

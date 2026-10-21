import { describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../../modules/developer/api-key.service';

function context(headers: Record<string, string>, isPublic = false) {
  const handler = () => undefined;
  class Controller {}
  const request: Record<string, unknown> = { headers };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY && isPublic),
  } as unknown as Reflector;
  const execution = {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { execution, reflector, request };
}

describe('ApiKeyAuthGuard', () => {
  it('authenticates a valid X-API-Key and attaches its tenant and scopes', async () => {
    const { execution, reflector, request } = context({ 'x-api-key': 'ast_live_valid' });
    const record = {
      id: 'key-1', organizationId: 'tenant-1', createdById: 'user-1',
      name: 'integration', prefix: 'ast_live_', permissions: ['transactions:read'],
      allowedIps: [],
    };
    const verify = vi.fn().mockResolvedValue(record);
    const guard = new ApiKeyAuthGuard(reflector, { verify } as unknown as ApiKeyService);

    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('ast_live_valid');
    expect(request.apiKey).toBe(record);
    expect(request.user).toMatchObject({
      id: 'key-1', organizationId: 'tenant-1', isApiKey: true,
      scopes: ['transactions:read'], role: UserRole.DEVELOPER,
    });
  });

  it('rejects an invalid API key', async () => {
    const { execution, reflector } = context({ 'x-api-key': 'invalid' });
    const guard = new ApiKeyAuthGuard(reflector, {
      verify: vi.fn().mockResolvedValue(null),
    } as unknown as ApiKeyService);
    await expect(guard.canActivate(execution)).rejects.toThrow('Invalid or expired API key');
  });

  it('rejects requests without an API key', async () => {
    const { execution, reflector } = context({});
    const verify = vi.fn();
    const guard = new ApiKeyAuthGuard(reflector, { verify } as unknown as ApiKeyService);
    await expect(guard.canActivate(execution)).rejects.toMatchObject({ status: 401 });
    expect(verify).not.toHaveBeenCalled();
  });

  it('bypasses authentication on @Public() routes', async () => {
    const { execution, reflector } = context({}, true);
    const verify = vi.fn();
    const guard = new ApiKeyAuthGuard(reflector, { verify } as unknown as ApiKeyService);
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
});

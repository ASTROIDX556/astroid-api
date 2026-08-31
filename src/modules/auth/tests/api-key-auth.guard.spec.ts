import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ApiKeyAuthGuard } from '../../../common/guards/api-key-auth.guard';
import { ApiKeyService } from '../../developer/api-key.service';
import { UnauthorizedException } from '../../../common/exceptions/domain.exception';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { sha256 } from '../../../utils/crypto.util';

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let reflector: Reflector;
  let apiKeyService: { verify: ReturnType<typeof vi.fn> };

  const validKey = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
  const orgId = 'org-guard-1';

  beforeEach(() => {
    reflector = new Reflector();
    apiKeyService = { verify: vi.fn() };
    guard = new ApiKeyAuthGuard(reflector, apiKeyService as unknown as ApiKeyService);
  });

  const createMockContext = (headers: Record<string, string | string[]> = {}): ExecutionContext => {
    const req: Record<string, unknown> = { headers };
    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
  };

  it('bypasses authentication when route is marked with @Public()', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === IS_PUBLIC_KEY) return true;
      return undefined;
    });

    const context = createMockContext();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.verify).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when x-api-key header is missing', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('Missing API key header');
  });

  it('authenticates a valid API key and attaches scoped permissions to the request', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue({
      id: 'key-valid',
      organizationId: orgId,
      createdById: 'user-1',
      name: 'Production Key',
      prefix: 'ak_live_abcdef',
      hashedKey: sha256(validKey),
      permissions: ['transactions:write', 'wallets:read'],
      allowedIps: ['10.0.0.1'],
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const context = createMockContext({ 'x-api-key': validKey });
    await expect(guard.canActivate(context)).resolves.toBe(true);

    const req = context.switchToHttp().getRequest();
    expect(apiKeyService.verify).toHaveBeenCalledWith(validKey);
    expect(req.user).toMatchObject({
      id: 'key-valid',
      organizationId: orgId,
      isApiKey: true,
      role: UserRole.DEVELOPER,
      permissions: ['transactions:write', 'wallets:read'],
      scopes: ['transactions:write', 'wallets:read'],
    });
    expect(req.apiKey).toMatchObject({ id: 'key-valid' });
  });

  it('throws UnauthorizedException when API key is invalid', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue(null);

    const context = createMockContext({ 'x-api-key': 'ak_live_invalidkey' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid or expired API key');
  });

  it('throws UnauthorizedException when API key is revoked', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue(null);

    const context = createMockContext({ 'x-api-key': validKey });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when API key is expired', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue(null);

    const context = createMockContext({ 'x-api-key': validKey });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('extracts API keys from Authorization ApiKey scheme', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue({
      id: 'key-auth-header',
      organizationId: orgId,
      name: 'Auth Header Key',
      prefix: 'ak_live_abcdef',
      hashedKey: sha256(validKey),
      permissions: ['*'],
      allowedIps: [],
      revokedAt: null,
      expiresAt: null,
    });

    const context = createMockContext({ authorization: `ApiKey ${validKey}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.verify).toHaveBeenCalledWith(validKey);
  });

  it('extracts API keys from Authorization Bearer scheme with ast_ prefix', async () => {
    const astKey = 'ast_live_abcdef1234567890abcdef1234567890abcdef12';
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue({
      id: 'key-ast-header',
      organizationId: orgId,
      name: 'Astroid Bearer Key',
      prefix: 'ast_live_abcd',
      hashedKey: sha256(astKey),
      permissions: ['*'],
      allowedIps: [],
      revokedAt: null,
      expiresAt: null,
    });

    const context = createMockContext({ authorization: `Bearer ${astKey}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.verify).toHaveBeenCalledWith(astKey);
  });

  it('extracts API keys from Authorization Bearer scheme with ak_ prefix', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    apiKeyService.verify.mockResolvedValue({
      id: 'key-ak-bearer',
      organizationId: orgId,
      name: 'AK Bearer Key',
      prefix: 'ak_live_abcdef',
      hashedKey: sha256(validKey),
      permissions: ['*'],
      allowedIps: [],
      revokedAt: null,
      expiresAt: null,
    });

    const context = createMockContext({ authorization: `Bearer ${validKey}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.verify).toHaveBeenCalledWith(validKey);
  });
});

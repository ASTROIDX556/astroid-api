import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RbacGuard } from './rbac.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

describe('RbacGuard & PermissionsGuard', () => {
  let guard: RbacGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RbacGuard(reflector);
  });

  const createMockContext = (user?: unknown): ExecutionContext => {
    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  it('allows access when no roles or permissions are required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const context = createMockContext({ id: 'u-1', role: UserRole.DEVELOPER });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('throws UnauthorizedException when user is missing', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ROLES_KEY) return [UserRole.ADMIN];
      return undefined;
    });
    const context = createMockContext(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('allows access for OWNER regardless of specific permissions', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === PERMISSIONS_KEY) return ['admin:write', 'treasury:config'];
      return undefined;
    });
    const context = createMockContext({ id: 'u-owner', role: UserRole.OWNER, permissions: [] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows access when user has the exact required permission', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === PERMISSIONS_KEY) return ['policies:write'];
      return undefined;
    });
    const context = createMockContext({
      id: 'u-dev',
      role: UserRole.DEVELOPER,
      permissions: ['policies:write'],
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('throws ForbiddenException when user lacks required permission', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === PERMISSIONS_KEY) return ['treasury:config'];
      return undefined;
    });
    const context = createMockContext({
      id: 'u-dev',
      role: UserRole.DEVELOPER,
      permissions: ['policies:read'],
    });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { PermissionsGuard } from './permissions.guard';

describe('RbacGuard & PermissionsGuard', () => {
  let rbacGuard: RbacGuard;
  let permissionsGuard: PermissionsGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    rbacGuard = new RbacGuard(reflector);
    permissionsGuard = new PermissionsGuard(reflector);
  });

  const createMockContext = (user?: Record<string, unknown>): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  describe('RbacGuard', () => {
    it('throws UnauthorizedException when user is missing', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
      const context = createMockContext(undefined);

      await expect(rbacGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when user role does not match', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
      const context = createMockContext({ role: 'USER' });

      await expect(rbacGuard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('allows access when user role matches', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN', 'OWNER']);
      const context = createMockContext({ role: 'ADMIN' });

      await expect(rbacGuard.canActivate(context)).resolves.toBe(true);
    });

    it('allows access when no roles are required', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const context = createMockContext({ role: 'USER' });

      await expect(rbacGuard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('PermissionsGuard', () => {
    it('throws UnauthorizedException when user is missing', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['read:reports']);
      const context = createMockContext(undefined);

      await expect(permissionsGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when user lacks permissions', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['write:reports']);
      const context = createMockContext({ permissions: ['read:reports'] });

      await expect(permissionsGuard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('allows access when user has required permissions', async () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['read:reports']);
      const context = createMockContext({ permissions: ['read:reports', 'write:reports'] });

      await expect(permissionsGuard.canActivate(context)).resolves.toBe(true);
    });
  });
});

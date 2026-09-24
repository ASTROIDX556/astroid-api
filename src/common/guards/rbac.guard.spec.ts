import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
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
    it('throws ForbiddenException when user is missing', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
      const context = createMockContext(undefined);

      expect(() => rbacGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when user role does not match', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
      const context = createMockContext({ role: 'USER' });

      expect(() => rbacGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows access when user role matches', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN', 'OWNER']);
      const context = createMockContext({ role: 'ADMIN' });

      expect(rbacGuard.canActivate(context)).toBe(true);
    });

    it('allows access when no roles are required', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const context = createMockContext({ role: 'USER' });

      expect(rbacGuard.canActivate(context)).toBe(true);
    });
  });

  describe('PermissionsGuard', () => {
    it('throws ForbiddenException when user is missing', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['read:reports']);
      const context = createMockContext(undefined);

      expect(() => permissionsGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when user lacks permissions', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['write:reports']);
      const context = createMockContext({ permissions: ['read:reports'] });

      expect(() => permissionsGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows access when user has required permissions', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['read:reports']);
      const context = createMockContext({ permissions: ['read:reports', 'write:reports'] });

      expect(permissionsGuard.canActivate(context)).toBe(true);
    });
  });
});

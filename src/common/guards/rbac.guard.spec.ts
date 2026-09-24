import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { PermissionsGuard } from './permissions.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { UnauthorizedException, ForbiddenException } from '../exceptions/domain.exception';

describe('RbacGuard & PermissionsGuard', () => {
  let reflector: Reflector;
  let rbacGuard: RbacGuard;
  let permissionsGuard: PermissionsGuard;

  beforeEach(() => {
    reflector = new Reflector();
    rbacGuard = new RbacGuard(reflector);
    permissionsGuard = new PermissionsGuard(reflector);
  });

  const createMockContext = (user?: Record<string, unknown>, roles?: string[], permissions?: string[]): ExecutionContext => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ROLES_KEY) return roles;
      if (key === PERMISSIONS_KEY) return permissions;
      return undefined;
    });

    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          user,
        }),
      }),
    } as unknown as ExecutionContext;
  };

  describe('RbacGuard', () => {
    it('throws UnauthorizedException when user is missing', async () => {
      const context = createMockContext(undefined, ['ADMIN']);
      await expect(rbacGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when user role does not match', async () => {
      const context = createMockContext({ role: 'USER' }, ['ADMIN']);
      await expect(rbacGuard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('allows access when user role matches', async () => {
      const context = createMockContext({ role: 'ADMIN', permissions: ['ADMIN', 'OWNER'] }, ['ADMIN'], ['ADMIN', 'OWNER']);
      await expect(rbacGuard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('PermissionsGuard', () => {
    it('throws UnauthorizedException when user is missing', () => {
      const context = createMockContext(undefined, undefined, ['write:reports']);
      expect(() => permissionsGuard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when user lacks permissions', () => {
      const context = createMockContext({ permissions: ['read:reports'] }, undefined, ['write:reports']);
      expect(() => permissionsGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows access when user has required permissions', () => {
      const context = createMockContext({ permissions: ['read:reports', 'write:reports'] }, undefined, ['read:reports']);
      expect(permissionsGuard.canActivate(context)).toBe(true);
    });
  });
});

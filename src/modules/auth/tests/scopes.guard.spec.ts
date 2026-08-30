import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { matchScope, ScopesGuard } from '../../../common/guards/scopes.guard';
import { SCOPES_KEY } from '../../../common/decorators/scopes.decorator';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ForbiddenException, UnauthorizedException } from '../../../common/exceptions/domain.exception';

describe('ScopesGuard & matchScope', () => {
  describe('matchScope helper', () => {
    it('matches exact scope', () => {
      expect(matchScope('transactions:write', 'transactions:write')).toBe(true);
      expect(matchScope('policies:read', 'policies:read')).toBe(true);
      expect(matchScope('transactions:write', 'transactions:read')).toBe(false);
    });

    it('matches resource wildcard', () => {
      expect(matchScope('transactions:*', 'transactions:write')).toBe(true);
      expect(matchScope('transactions:*', 'transactions:read')).toBe(true);
      expect(matchScope('transactions:*', 'wallets:read')).toBe(false);
    });

    it('matches global wildcard * and admin', () => {
      expect(matchScope('*', 'transactions:write')).toBe(true);
      expect(matchScope('*', 'wallets:read')).toBe(true);
      expect(matchScope('admin', 'transactions:write')).toBe(true);
      expect(matchScope('admin', 'policies:delete')).toBe(true);
    });
  });

  describe('ScopesGuard', () => {
    let guard: ScopesGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new ScopesGuard(reflector);
    });

    const createMockContext = (user?: unknown, apiKey?: unknown): ExecutionContext => {
      return {
        getHandler: vi.fn(),
        getClass: vi.fn(),
        switchToHttp: () => ({
          getRequest: () => ({
            user,
            apiKey,
          }),
        }),
      } as unknown as ExecutionContext;
    };

    it('allows access when route is @Public()', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return true;
        if (key === SCOPES_KEY) return ['transactions:write'];
        return undefined;
      });

      const context = createMockContext(null);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access when route requires no scopes', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return undefined;
        return undefined;
      });

      const context = createMockContext({ id: 'user-1' });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('throws UnauthorizedException when user is unauthenticated on scoped route', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:write'];
        return undefined;
      });

      const context = createMockContext(undefined);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('allows access for JWT OWNER or ADMIN users', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:write'];
        return undefined;
      });

      const ownerContext = createMockContext({
        id: 'owner-1',
        role: UserRole.OWNER,
        isApiKey: false,
      });
      const adminContext = createMockContext({
        id: 'admin-1',
        role: UserRole.ADMIN,
        isApiKey: false,
      });

      expect(guard.canActivate(ownerContext)).toBe(true);
      expect(guard.canActivate(adminContext)).toBe(true);
    });

    it('allows access when API key has exact required scope', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:write'];
        return undefined;
      });

      const context = createMockContext({
        id: 'key-1',
        isApiKey: true,
        permissions: ['transactions:write', 'wallets:read'],
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access when API key has wildcard scope', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:write', 'transactions:read'];
        return undefined;
      });

      const resourceWildcardContext = createMockContext({
        id: 'key-1',
        isApiKey: true,
        scopes: ['transactions:*'],
      });
      const globalWildcardContext = createMockContext({
        id: 'key-2',
        isApiKey: true,
        scopes: ['*'],
      });

      expect(guard.canActivate(resourceWildcardContext)).toBe(true);
      expect(guard.canActivate(globalWildcardContext)).toBe(true);
    });

    it('throws ForbiddenException when API key is missing required scope', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:write', 'policies:delete'];
        return undefined;
      });

      const context = createMockContext({
        id: 'key-1',
        isApiKey: true,
        permissions: ['transactions:write'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        'Insufficient API key permissions. Missing required scope(s): policies:delete',
      );
    });
  });
});

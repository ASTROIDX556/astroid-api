import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { matchScope, ScopesGuard } from '../../../common/guards/scopes.guard';
import {
  SCOPES_KEY,
  RequireScopes,
  RequiredScopes,
  Scopes,
} from '../../../common/decorators/scopes.decorator';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ForbiddenException, UnauthorizedException } from '../../../common/exceptions/domain.exception';

describe('ScopesGuard & matchScope', () => {
  describe('@RequiredScopes and @RequireScopes decorator', () => {
    it('sets metadata properly using @RequiredScopes and @RequireScopes', () => {
      class TestController {
        @RequiredScopes('transactions:execute', 'webhooks:manage')
        createTransaction() {}

        @RequireScopes('write')
        updateWallet() {}

        @Scopes('read')
        getPolicy() {}
      }

      const reflector = new Reflector();
      const instance = new TestController();

      const scopesFromRequired = reflector.get<string[]>(
        SCOPES_KEY,
        instance.createTransaction,
      );
      const scopesFromRequire = reflector.get<string[]>(
        SCOPES_KEY,
        instance.updateWallet,
      );
      const scopesFromScopes = reflector.get<string[]>(
        SCOPES_KEY,
        instance.getPolicy,
      );

      expect(scopesFromRequired).toEqual(['transactions:execute', 'webhooks:manage']);
      expect(scopesFromRequire).toEqual(['write']);
      expect(scopesFromScopes).toEqual(['read']);
    });
  });
  describe('matchScope helper', () => {
    it('matches exact scope', () => {
      expect(matchScope('transactions:execute', 'transactions:execute')).toBe(true);
      expect(matchScope('read', 'read')).toBe(true);
      expect(matchScope('transactions:execute', 'read')).toBe(false);
    });

    it('rejects scopes outside the typed API key scope vocabulary', () => {
      expect(matchScope('transactions:*', 'transactions:execute')).toBe(false);
      expect(matchScope('*', 'transactions:execute')).toBe(false);
      expect(matchScope('admin', 'transactions:execute')).toBe(false);
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
        if (key === SCOPES_KEY) return ['transactions:execute'];
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
        if (key === SCOPES_KEY) return ['transactions:execute'];
        return undefined;
      });

      const context = createMockContext(undefined);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('allows access for JWT OWNER or ADMIN users', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:execute'];
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
        if (key === SCOPES_KEY) return ['transactions:execute'];
        return undefined;
      });

      const context = createMockContext({
        id: 'key-1',
        isApiKey: true,
        scopes: ['transactions:execute', 'webhooks:manage'],
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('rejects access when API key has an invalid wildcard scope', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:execute', 'webhooks:manage'];
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

      expect(() => guard.canActivate(resourceWildcardContext)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(globalWildcardContext)).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when API key is missing required scope', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SCOPES_KEY) return ['transactions:execute', 'webhooks:manage'];
        return undefined;
      });

      const context = createMockContext({
        id: 'key-1',
        isApiKey: true,
        scopes: ['transactions:execute'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        'Insufficient API key permissions. Missing required scope(s): webhooks:manage',
      );
    });
  });
});

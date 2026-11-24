import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { matchScope, ScopesGuard } from './scopes.guard';
import { RequireScopes, RequiredScopes, Scopes } from '../decorators/scopes.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ErrorCode } from '../constants/error-codes';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

describe('matchScope', () => {
  /** [granted, required, expected] */
  const matrix: Array<[string, string, boolean]> = [
    // Exact
    ['read', 'read', true],
    ['transactions:execute', 'transactions:execute', true],
    ['transactions:execute', 'webhooks:manage', false],
    ['admin', 'read', false],
    ['*', 'read', false],
    ['transactions:*', 'transactions:execute', false],
    ['transactions:write', 'transactions:execute', false],
    ['', 'read', false],
  ];

  it.each(matrix)('granted %j, required %j -> %s', (granted, required, expected) => {
    expect(matchScope(granted, required)).toBe(expected);
  });
});

@RequireScopes('read')
class TransactionsController {
  inheritsClass() {}

  @Scopes('transactions:execute', 'webhooks:manage')
  requiresTwo() {}

  @RequiredScopes()
  emptyHandler() {}

  @Public()
  publicHandler() {}
}

@Public()
class PublicController {
  @RequireScopes('write')
  scopedButPublic() {}
}

class OpenController {
  unrestricted() {}
}

interface Principal {
  role?: UserRole;
  isApiKey?: boolean;
  scopes?: string[];
  permissions?: string[];
}

function user({ role = UserRole.VIEWER, ...rest }: Principal = {}): AuthenticatedUser {
  return { id: 'u-1', organizationId: 'org-1', role, ...rest };
}

function context(
  cls: new () => object,
  handler: string,
  principal?: AuthenticatedUser,
  apiKey?: { scopes?: string[] },
): ExecutionContext {
  const target = cls.prototype as Record<string, () => void>;
  return {
    getHandler: () => target[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: principal, apiKey }) }),
  } as unknown as ExecutionContext;
}

describe('ScopesGuard', () => {
  const guard = new ScopesGuard(new Reflector());

  describe('public and unrestricted routes', () => {
    it.each([
      [TransactionsController, 'publicHandler'],
      [PublicController, 'scopedButPublic'],
    ] as const)('lets a guest through @Public() on %s.%s', (cls, handler) => {
      expect(guard.canActivate(context(cls, handler))).toBe(true);
    });

    it('lets a guest through a route without scope metadata', () => {
      expect(guard.canActivate(context(OpenController, 'unrestricted'))).toBe(true);
    });

    it('treats an empty handler requirement as no restriction, overriding the class', () => {
      expect(guard.canActivate(context(TransactionsController, 'emptyHandler', user()))).toBe(true);
    });
  });

  describe('guest access', () => {
    it('rejects an unauthenticated request with 401 and the UNAUTHORIZED code', () => {
      let caught: unknown;
      try {
        guard.canActivate(context(TransactionsController, 'inheritsClass'));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnauthorizedException);
      expect((caught as UnauthorizedException).code).toBe(ErrorCode.UNAUTHORIZED);
      expect((caught as UnauthorizedException).getStatus()).toBe(401);
    });

    it('rejects an expired API key (auth layer attached no principal) even if its scopes arrive', () => {
      expect(() =>
        guard.canActivate(
          context(TransactionsController, 'inheritsClass', undefined, { scopes: ['read'] }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('administrative override', () => {
    it.each([UserRole.OWNER, UserRole.ADMIN])(
      'a JWT-authenticated %s satisfies every scope without holding any',
      (role) => {
        expect(
          guard.canActivate(context(TransactionsController, 'requiresTwo', user({ role }))),
        ).toBe(true);
      },
    );

    it.each([UserRole.OWNER, UserRole.ADMIN])(
      'an API key carrying the %s role gets no bypass and must hold the scopes',
      (role) => {
        expect(() =>
          guard.canActivate(
            context(TransactionsController, 'requiresTwo', user({ role, isApiKey: true })),
          ),
        ).toThrow(ForbiddenException);
      },
    );

    it.each([UserRole.FINANCE, UserRole.DEVELOPER, UserRole.AUDITOR, UserRole.VIEWER])(
      'a JWT-authenticated %s gets no bypass',
      (role) => {
        expect(() =>
          guard.canActivate(context(TransactionsController, 'inheritsClass', user({ role }))),
        ).toThrow(ForbiddenException);
      },
    );
  });

  describe('scope sources', () => {
    it.each<[string, AuthenticatedUser, { scopes?: string[] } | undefined]>([
      ['user.scopes', user({ scopes: ['read'] }), undefined],
      ['request.apiKey.scopes', user(), { scopes: ['read'] }],
    ])('accepts a scope granted via %s', (_source, principal, apiKey) => {
      expect(
        guard.canActivate(context(TransactionsController, 'inheritsClass', principal, apiKey)),
      ).toBe(true);
    });

    it('combines scopes from every source to satisfy a multi-scope route', () => {
      expect(
        guard.canActivate(
          context(TransactionsController, 'requiresTwo', user({ scopes: ['transactions:execute'] }), {
            scopes: ['webhooks:manage'],
          }),
        ),
      ).toBe(true);
    });

    it('does not treat legacy permissions as scopes', () => {
      expect(() =>
        guard.canActivate(
          context(
            TransactionsController,
            'inheritsClass',
            user({ permissions: ['admin'] }),
            { scopes: [] },
          ),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('standard user restrictions', () => {
    it('lists only the missing scopes in the 403 message', () => {
      expect(() =>
        guard.canActivate(
          context(TransactionsController, 'requiresTwo', user({ scopes: ['read'] })),
        ),
      ).toThrow('Missing required scope(s): transactions:execute');
    });

    it('lists every missing scope when none are held', () => {
      expect(() =>
        guard.canActivate(context(TransactionsController, 'requiresTwo', user({ isApiKey: true }))),
      ).toThrow('Missing required scope(s): transactions:execute, webhooks:manage');
    });

    it('accepts each required scope on a multi-scope route', () => {
      expect(
        guard.canActivate(
          context(
            TransactionsController,
            'requiresTwo',
            user({ isApiKey: true, scopes: ['transactions:execute', 'webhooks:manage'] }),
          ),
        ),
      ).toBe(true);
    });

    it('rejects a partial grant on a multi-scope route', () => {
      expect(() =>
        guard.canActivate(
          context(TransactionsController, 'requiresTwo', user({ scopes: ['transactions:execute'] })),
        ),
      ).toThrow('Missing required scope(s): webhooks:manage');
    });
  });
});

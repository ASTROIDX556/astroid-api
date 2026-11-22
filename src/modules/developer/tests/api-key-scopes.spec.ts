import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { createApiKeySchema } from '../api-key.dto';
import { ScopesGuard } from '../../../common/guards/scopes.guard';
import { RequiredScopes } from '../../../common/decorators/scopes.decorator';
import { DEFAULT_API_KEY_SCOPES } from '../../../common/constants/scopes';
import { ForbiddenException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';
import { ExecutionContext } from '@nestjs/common';
import { AuthenticatedApiKey } from '../../../common/interfaces/authenticated-user.interface';

class MockTransactionController {
  @RequiredScopes('transactions:execute')
  executeTransaction() {
    return { success: true };
  }

  @RequiredScopes('write')
  mutateDeveloperKey() {
    return { success: true };
  }

  @RequiredScopes('webhooks:manage')
  manageWebhook() {
    return { success: true };
  }

  @RequiredScopes('read')
  readOnlyEndpoint() {
    return { success: true };
  }
}

function createMockContext(
  handlerName: keyof MockTransactionController,
  apiKey: Partial<AuthenticatedApiKey>,
): ExecutionContext {
  const target = MockTransactionController.prototype as unknown as Record<string, () => unknown>;
  const req = {
    user: {
      id: apiKey.id ?? 'key-user-1',
      organizationId: apiKey.organizationId ?? 'org-1',
      role: UserRole.DEVELOPER,
      isApiKey: true,
      scopes: apiKey.scopes ?? [],
      permissions: apiKey.permissions ?? [],
    },
    apiKey,
  };

  return {
    getHandler: () => target[handlerName],
    getClass: () => MockTransactionController,
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('API Key Scopes', () => {
  describe('createApiKeySchema validation', () => {
    it('defaults to ["read"] when scopes is omitted', () => {
      const parsed = createApiKeySchema.parse({ name: 'Default Scope Key' });
      expect(parsed.scopes).toEqual([...DEFAULT_API_KEY_SCOPES]);
    });

    it('accepts valid defined scopes', () => {
      const parsed = createApiKeySchema.parse({
        name: 'Custom Scope Key',
        scopes: ['read', 'transactions:execute', 'webhooks:manage'],
      });
      expect(parsed.scopes).toEqual(['read', 'transactions:execute', 'webhooks:manage']);
    });

    it('rejects unknown scopes', () => {
      expect(() =>
        createApiKeySchema.parse({
          name: 'Invalid Scope Key',
          scopes: ['admin:everything' as unknown as (typeof DEFAULT_API_KEY_SCOPES)[number]],
        }),
      ).toThrow();
    });

    it('rejects empty scopes array', () => {
      expect(() =>
        createApiKeySchema.parse({
          name: 'Empty Scope Key',
          scopes: [],
        }),
      ).toThrow();
    });
  });

  describe('ScopesGuard with API Keys', () => {
    const reflector = new Reflector();
    const guard = new ScopesGuard(reflector);

    it('allows an API key with the exact required scope', () => {
      const context = createMockContext('executeTransaction', {
        id: 'key-1',
        scopes: ['transactions:execute'],
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows an API key possessing multiple scopes including the required one', () => {
      const context = createMockContext('manageWebhook', {
        id: 'key-1',
        scopes: ['read', 'webhooks:manage'],
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('denies an API key missing the required scope with 403 Forbidden', () => {
      const context = createMockContext('executeTransaction', {
        id: 'key-1',
        scopes: ['read'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      try {
        guard.canActivate(context);
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const forbidden = err as ForbiddenException;
        expect(forbidden.getStatus()).toBe(403);
        expect(forbidden.code).toBe(ErrorCode.FORBIDDEN);
        expect(forbidden.message).toContain('transactions:execute');
        expect(forbidden.message).not.toContain('key-1');
      }
    });

    it('allows OWNER JWT user to bypass scope requirements', () => {
      const target = MockTransactionController.prototype as unknown as Record<string, () => unknown>;
      const ownerContext = {
        getHandler: () => target.executeTransaction,
        getClass: () => MockTransactionController,
        switchToHttp: () => ({
          getRequest: () => ({
            user: {
              id: 'owner-user',
              role: UserRole.OWNER,
              isApiKey: false,
              scopes: [],
            },
          }),
        }),
      } as unknown as ExecutionContext;

      expect(guard.canActivate(ownerContext)).toBe(true);
    });

    it('allows ADMIN JWT user to bypass scope requirements', () => {
      const target = MockTransactionController.prototype as unknown as Record<string, () => unknown>;
      const adminContext = {
        getHandler: () => target.manageWebhook,
        getClass: () => MockTransactionController,
        switchToHttp: () => ({
          getRequest: () => ({
            user: {
              id: 'admin-user',
              role: UserRole.ADMIN,
              isApiKey: false,
              scopes: [],
            },
          }),
        }),
      } as unknown as ExecutionContext;

      expect(guard.canActivate(adminContext)).toBe(true);
    });
  });
});

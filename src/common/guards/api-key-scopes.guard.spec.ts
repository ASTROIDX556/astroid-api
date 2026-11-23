import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyScopesGuard } from './api-key-scopes.guard';
import { REQUIRED_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { API_KEY_SCOPES } from '../constants/api-key-scopes';
import {
  ForbiddenException,
  UnauthorizedException,
} from '../exceptions/domain.exception';
import { AuthenticatedApiKey } from '../interfaces/authenticated-user.interface';

function contextFor(apiKey?: AuthenticatedApiKey): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ apiKey }) }),
  } as unknown as ExecutionContext;
}

function guardFor(required?: string[]): ApiKeyScopesGuard {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
  return new ApiKeyScopesGuard(reflector);
}

const baseKey: AuthenticatedApiKey = {
  id: 'key_1',
  organizationId: 'org_1',
  name: 'CI key',
  prefix: 'ak_live_abc',
  scopes: [API_KEY_SCOPES.TransactionCreate],
  permissions: [],
  revokedAt: null,
  expiresAt: null,
};

describe('ApiKeyScopesGuard', () => {
  it('allows routes without scope metadata', () => {
    const guard = guardFor(undefined);
    expect(guard.canActivate(contextFor({ ...baseKey, scopes: [] }))).toBe(true);
  });

  it('leaves JWT-authenticated requests untouched (no apiKey principal)', () => {
    const guard = guardFor([API_KEY_SCOPES.PolicyWrite]);
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
  });

  it('allows a key that holds the required scope', () => {
    const guard = guardFor([API_KEY_SCOPES.TransactionCreate]);
    expect(guard.canActivate(contextFor(baseKey))).toBe(true);
  });

  it('denies with 403 when the required scope is missing', () => {
    const guard = guardFor([API_KEY_SCOPES.PolicyWrite]);
    expect(() => guard.canActivate(contextFor(baseKey))).toThrow(ForbiddenException);
  });

  it('requires every declared scope (AND semantics)', () => {
    const guard = guardFor([
      API_KEY_SCOPES.TransactionCreate,
      API_KEY_SCOPES.PolicyWrite,
    ]);
    expect(() => guard.canActivate(contextFor(baseKey))).toThrow(ForbiddenException);
  });

  it('rejects a revoked key with 401', () => {
    const guard = guardFor([API_KEY_SCOPES.TransactionCreate]);
    const revoked = { ...baseKey, revokedAt: new Date() };
    expect(() => guard.canActivate(contextFor(revoked))).toThrow(UnauthorizedException);
  });

  it('rejects an expired key with 401', () => {
    const guard = guardFor([API_KEY_SCOPES.TransactionCreate]);
    const expired = { ...baseKey, expiresAt: new Date(Date.now() - 1000) };
    expect(() => guard.canActivate(contextFor(expired))).toThrow(UnauthorizedException);
  });

  it('treats a legacy key with an empty scope set as unrestricted', () => {
    const guard = guardFor([API_KEY_SCOPES.PolicyWrite]);
    expect(guard.canActivate(contextFor({ ...baseKey, scopes: [] }))).toBe(true);
  });

  it('exports the metadata key used by @RequireScopes', () => {
    expect(REQUIRED_SCOPES_KEY).toBe('astroid:required-scopes');
  });
});

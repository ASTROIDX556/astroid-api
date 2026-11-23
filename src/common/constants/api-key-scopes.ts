import { z } from 'zod';

/**
 * The canonical API-key scope vocabulary (#539). This is the single source of
 * truth: DTO validation, the authorization guard and the docs all read from it.
 * Names follow `<resource>:<action>` and mirror the route/event naming used by
 * the rest of the API.
 */
export const API_KEY_SCOPES = {
  WalletRead: 'wallet:read',
  WalletWrite: 'wallet:write',
  TransactionRead: 'transaction:read',
  TransactionCreate: 'transaction:create',
  PolicyRead: 'policy:read',
  PolicyWrite: 'policy:write',
  BudgetRead: 'budget:read',
  BudgetWrite: 'budget:write',
  ApprovalWrite: 'approval:write',
  WebhookRead: 'webhook:read',
  WebhookManage: 'webhook:manage',
  AuditRead: 'audit:read',
  ApiKeyManage: 'api_key:manage',
} as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[keyof typeof API_KEY_SCOPES];

/** Every allowed scope, in documentation order. */
export const API_KEY_SCOPE_VALUES: readonly ApiKeyScope[] = Object.values(API_KEY_SCOPES);

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPE_VALUES as readonly string[]).includes(value);
}

/** Zod enum for a single scope; rejects anything outside the canonical list. */
export const apiKeyScopeSchema = z.enum(
  API_KEY_SCOPE_VALUES as readonly [ApiKeyScope, ...ApiKeyScope[]],
);

/**
 * Legacy compatibility: keys created before scopes existed have an empty scope
 * set and retain full access. A key created with an explicit scope list is
 * restricted to it — there is no way to create a new "empty means all" key.
 */
export function hasScopeGrant(grantedScopes: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0 || grantedScopes.length === 0) {
    return true;
  }
  const granted = new Set(grantedScopes);
  return required.every((scope) => granted.has(scope));
}

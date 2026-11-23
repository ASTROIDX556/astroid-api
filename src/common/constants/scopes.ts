export const API_KEY_SCOPES = [
  'read',
  'write',
  'transactions:execute',
  'webhooks:manage',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = ['read'] as const;

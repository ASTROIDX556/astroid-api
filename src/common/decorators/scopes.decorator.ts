import { SetMetadata } from '@nestjs/common';
import { ApiKeyScope } from '../constants/scopes';

export const SCOPES_KEY = 'astroid:scopes';

/**
 * Restricts a route to API keys (or principals) possessing specific permission scopes.
 * Supports exact scopes (e.g. `'transactions:write'`) and wildcards (e.g. `'transactions:*'`, `'*'`).
 * Example: `@RequireScopes('transactions:write', 'wallets:read')`.
 */
export const RequireScopes = (...scopes: ApiKeyScope[]) => SetMetadata(SCOPES_KEY, scopes);

/** Alias for RequireScopes */
export const Scopes = RequireScopes;

/** Alias for RequireScopes (e.g., @RequiredScopes('transactions:write')) */
export const RequiredScopes = RequireScopes;


import { SetMetadata } from '@nestjs/common';
import { ApiKeyScope } from '../constants/api-key-scopes';

export const REQUIRED_SCOPES_KEY = 'astroid:required-scopes';

/**
 * Declares the API-key scopes a handler requires, e.g.
 * `@RequireScopes(ApiKeyScope.TransactionCreate)`.
 *
 * The metadata is consumed by {@link ApiKeyScopesGuard}. Routes without a
 * declaration keep working for every key; JWT-authenticated sessions are not
 * affected by scope checks at all.
 */
export const RequireScopes = (...scopes: ApiKeyScope[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

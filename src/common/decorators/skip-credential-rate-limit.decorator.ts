import { SetMetadata } from '@nestjs/common';

export const SKIP_CREDENTIAL_RATE_LIMIT_KEY = 'astroid:skipCredentialRateLimit';

/**
 * Exempts a route (or controller) from the per-credential
 * `CredentialRateLimitGuard`, e.g. health/readiness probes and the internal
 * metrics scrape endpoint, which must answer even when a caller is out of quota.
 */
export const SkipCredentialRateLimit = () => SetMetadata(SKIP_CREDENTIAL_RATE_LIMIT_KEY, true);

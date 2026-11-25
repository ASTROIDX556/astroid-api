import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';

/**
 * Security schemes accepted by `JwtAuthGuard`, which runs the `jwt` and
 * `api-key` strategies. Both are valid credentials for a protected route, so
 * they are documented as alternatives rather than as a combined requirement.
 */
export const AUTH_SECURITY_SCHEMES = ['access-token', 'api-key'] as const;

/**
 * Marks a controller or handler as authenticated and documents every credential
 * it accepts: a bearer JWT or an API key.
 */
export function ApiAuthenticated() {
  return applyDecorators(ApiBearerAuth('access-token'), ApiSecurity('api-key'));
}
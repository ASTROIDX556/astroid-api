import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { SensitiveRateLimitGuard } from '../guards/sensitive-rate-limit.guard';
import { SENSITIVE_RATE_LIMIT_KEY, SensitiveRoute } from '../throttler/sensitive-route-policy';

/**
 * Puts a route under the sensitive-route limiter with the budget configured for
 * `route` (`rateLimit.sensitive.<route>`), and attaches the guard that enforces
 * it. The failure mode when Redis is down comes from `SENSITIVE_ROUTE_POLICY`.
 *
 * ```ts
 * @Post('login')
 * @SensitiveRateLimit('login')
 * login() {}
 * ```
 */
export const SensitiveRateLimit = (route: SensitiveRoute) =>
  applyDecorators(SetMetadata(SENSITIVE_RATE_LIMIT_KEY, route), UseGuards(SensitiveRateLimitGuard));

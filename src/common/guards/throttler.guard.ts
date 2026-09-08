import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  THROTTLE_TIER_KEY,
  ThrottleTier,
} from '../decorators/throttle-tier.decorator';

/**
 * Rate-limit guard with two tiers. Every route is evaluated against both named
 * throttlers ('api' = 120/min, 'auth' = 10/min by default), but each throttler
 * only counts a request when its name matches the route's tier — so the auth
 * endpoints (marked `@ThrottleTierDecorator('auth')`) get the stricter limit
 * while everything else falls back to the `api` tier.
 *
 * The counter is scoped to the authenticated organization, falling back to the
 * client IP for anonymous auth endpoints.
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  /**
   * Enforce a named throttler only when it matches the route's declared tier.
   * Routes without an explicit tier default to `api`.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;
    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';

    // This named throttler does not govern this route's tier — do not count it.
    if (throttler.name !== routeTier) {
      return true;
    }

    return super.handleRequest(requestProps);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & { user?: AuthenticatedUser };
    const org = request.user?.organizationId;
    if (org) {
      return `org:${org}`;
    }
    const forwarded = request.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ??
      request.ip ??
      request.socket?.remoteAddress ??
      'anonymous';
    return `ip:${ip}`;
  }
}

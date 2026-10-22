import { createHash } from 'node:crypto';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { extractApiKeyFromRequest } from '../helpers/extract-api-key';
import { THROTTLE_TIER_KEY, ThrottleTier } from '../decorators/throttle-tier.decorator';
import {
  resolveApiKeyScopeTier,
  TIER_RESTRICTIVENESS,
} from '../throttler/api-key-scope-tier';

/**
 * Rate-limit guard with per-tier steady-state and burst throttlers.
 *
 * Each route is evaluated against every registered named throttler, but a
 * throttler fires only when its name matches the route's **effective** tier:
 *
 *  - A throttler named `'api'` fires only on `api`-tier routes.
 *  - A throttler named `'api-burst'` fires only on `api`-tier routes
 *    (the `-burst` suffix is stripped for comparison).
 *  - Routes without an explicit `@ThrottleTierDecorator` default to `api`.
 *
 * This means auth endpoints (marked `@ThrottleTierDecorator('auth')`) get the
 * stricter steady-state limit **and** the tighter burst limit, while everything
 * else is governed by the `api` pair.
 *
 * The effective tier is the **most restrictive** of the route-declared tier and
 * the tier the caller's API key scopes map to (see
 * `api-key-scope-tier.ts`). A key holding credential-management scopes is
 * therefore held to the `auth` budget even on a generic `api` route, while a
 * high-volume agent key keeps the looser `agent` budget it is entitled to.
 *
 * The counter is scoped to the authenticated organization, falling back to the
 * client IP for anonymous requests (e.g. auth endpoints before login).
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  /**
   * Enforce a named throttler only when its base tier matches the route's
   * effective tier. The base tier of `'api-burst'` is `'api'`, so the burst
   * throttler fires on the same set of routes as its steady-state counterpart.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;
    const effectiveTier = this.resolveEffectiveTier(context);

    // Strip the optional `-burst` suffix to get the base tier name.
    const throttlerBaseTier = throttler.name?.replace(/-burst$/, '') as ThrottleTier | undefined;

    // This named throttler does not govern this route's tier — do not count it.
    if (throttlerBaseTier !== effectiveTier) {
      return true;
    }

    return super.handleRequest(requestProps);
  }

  /**
   * The tier that governs this request: the route-declared tier, tightened to
   * the API key's scope tier when that tier is the stricter of the two.
   */
  protected resolveEffectiveTier(context: ExecutionContext): ThrottleTier {
    const routeTier =
      this.reflector.getAllAndOverride<ThrottleTier>(THROTTLE_TIER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'api';

    const scopeTier = resolveApiKeyScopeTier(this.apiKeyScopes(context));
    if (!scopeTier || scopeTier === routeTier) {
      return routeTier;
    }

    return this.isStricter(scopeTier, routeTier) ? scopeTier : routeTier;
  }

  /**
   * Permission scopes of the calling API key. Only API-key principals carry
   * scopes — a JWT principal is governed by the route-declared tier alone.
   */
  private apiKeyScopes(context: ExecutionContext): string[] {
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthenticatedUser;
        apiKey?: { permissions?: string[] };
      }
    >();

    const user = request.user;
    if (!user?.isApiKey) {
      return [];
    }

    return [
      ...(user.scopes ?? []),
      ...(user.permissions ?? []),
      ...(request.apiKey?.permissions ?? []),
    ];
  }

  /**
   * Compares two tiers by their configured steady-state limit, so the tighter
   * budget always wins regardless of how the tiers are configured. Falls back
   * to the static restrictiveness ranking when a limit is not a plain number
   * (resolvable limits are resolved later, per request).
   */
  private isStricter(candidate: ThrottleTier, current: ThrottleTier): boolean {
    const candidateLimit = this.tierLimit(candidate);
    const currentLimit = this.tierLimit(current);

    if (candidateLimit === undefined || currentLimit === undefined) {
      return TIER_RESTRICTIVENESS[candidate] > TIER_RESTRICTIVENESS[current];
    }

    return candidateLimit < currentLimit;
  }

  /** Configured limit of a tier's steady-state throttler, when it is a number. */
  private tierLimit(tier: ThrottleTier): number | undefined {
    const throttler = (this.throttlers ?? []).find((option) => option.name === tier);
    return typeof throttler?.limit === 'number' ? throttler.limit : undefined;
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & {
      user?: AuthenticatedUser;
      apiKey?: { id: string };
    };
    const verifiedId = request.apiKey?.id ?? (request.user?.isApiKey ? (request.user.apiKeyId ?? request.user.id) : undefined);
    if (verifiedId) {
      return `apikey:${verifiedId}`;
    }
    // This guard can also run without an authenticated principal (e.g. public
    // routes). Hash any presented key so Redis never stores raw credentials.
    const rawKey = extractApiKeyFromRequest(request);
    if (rawKey) {
      return `apikey-sha256:${createHash('sha256').update(rawKey).digest('hex')}`;
    }
    const sub = request.user?.sub ?? request.user?.id;
    if (sub) {
      return `user:${sub}`;
    }
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

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  THROTTLE_TIER_KEY,
  ThrottleTier,
} from '../decorators/throttle-tier.decorator';
import { QueueConfig } from '../../config/queue.config';

/** Per-tier burst defaults (requests per second). */
const BURST_DEFAULTS: Record<ThrottleTier, number> = {
  api: 10,
  auth: 3,
  webhook: 5,
};

/**
 * Rate-limit guard with three tiers — api, auth, and webhook.
 *
 * Every route is evaluated against all named throttlers, but each throttler
 * only counts a request when its name matches the route's tier. The tier is
 * selected via @ThrottleTierDecorator; routes without an explicit tier
 * default to `api`.
 *
 * Burst limiting: each tier has a per-second burst ceiling (burstLimit).
 * If the request rate exceeds the burst ceiling within any 1-second window,
 * the request is rejected immediately — regardless of the per-minute steady
 * state limit.
 *
 * Response headers:
 *   X-RateLimit-Limit     — steady-state limit for the matched tier
 *   X-RateLimit-Remaining — remaining requests in the current TTL window
 *   X-RateLimit-Reset     — UTC epoch seconds when the window resets
 *   Retry-After           — seconds until the next request is allowed (only on 429)
 *
 * The counter is scoped to the authenticated organization, falling back to
 * the client IP for anonymous/auth endpoints.
 */
@Injectable()
export class AstroidThrottlerGuard extends ThrottlerGuard {
  /** Per-second burst tracking: keyed by "tier:scope". */
  private readonly burstWindows = new Map<string, { count: number; resetAt: number }>();

  /** Burst limits resolved from config at first request. */
  private burstLimits: Record<string, number> | null = null;

  constructor(
    private readonly cfg: ConfigService,
  ) {
    // ThrottlerGuard's constructor is injected by NestJS; we pass through.
    // The `cfg` param is used only for burst limits; the parent handles the rest.
    super(undefined as never, undefined as never, undefined as never);
  }

  /**
   * Enforce a named throttler only when it matches the route's declared tier.
   * Also enforces burst limits and sets rate-limit response headers.
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

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse<Response>();

    // ── Burst check ────────────────────────────────────────────────────────
    const burstKey = this.burstKey(request, routeTier);
    if (this.isBurstExceeded(routeTier, burstKey)) {
      response.setHeader('Retry-After', 1);
      return false;
    }

    // ── Steady-state check ─────────────────────────────────────────────────
    const result = await super.handleRequest(requestProps);

    // ── Response headers ───────────────────────────────────────────────────
    const limit = typeof throttler.limit === 'function'
      ? throttler.limit(context)
      : throttler.limit;
    const ttl = typeof throttler.ttl === 'function'
      ? throttler.ttl(context)
      : throttler.ttl;

    response.setHeader('X-RateLimit-Limit', limit);
    response.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + ttl) / 1000));

    if (!result) {
      response.setHeader('Retry-After', Math.ceil(ttl / 1000));
    }

    return result;
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

  // ── Burst internals ────────────────────────────────────────────────────

  private burstKey(request: Request & { user?: AuthenticatedUser }, tier: ThrottleTier): string {
    const org = request.user?.organizationId;
    const scope = org ? `org:${org}` : `ip:${request.ip ?? 'anonymous'}`;
    return `${tier}:${scope}`;
  }

  /**
   * Simple fixed-window burst limiter: tracks the number of requests in the
   * current 1-second window. Returns true when the burst ceiling is hit.
   */
  private isBurstExceeded(tier: ThrottleTier, key: string): boolean {
    const now = Date.now();
    const burstLimit = this.getBurstLimit(tier);
    const window = this.burstWindows.get(key);

    if (!window || now > window.resetAt) {
      // New 1-second window
      this.burstWindows.set(key, { count: 1, resetAt: now + 1000 });
      return false;
    }

    window.count++;
    return window.count > burstLimit;
  }

  private getBurstLimit(tier: ThrottleTier): number {
    if (!this.burstLimits) {
      const throttle = this.cfg.getOrThrow<QueueConfig>('queue').throttle;
      this.burstLimits = {
        api: throttle.apiBurst,
        auth: throttle.authBurst,
        webhook: throttle.webhookBurst,
      };
    }
    return this.burstLimits[tier] ?? BURST_DEFAULTS[tier];
  }
}

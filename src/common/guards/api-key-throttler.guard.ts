import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { InjectThrottlerOptions, InjectThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { API_KEY_HEADER } from '../constants/headers';
import { ApiKeyService } from '../../modules/developer/api-key.service';

/**
 * Metadata key for per-route limit overrides.
 * Set via `@SetMetadata(API_KEY_THROTTLE_LIMIT_KEY, 200)` to grant an org
 * a custom quota above the default 100 req/min.
 */
export const API_KEY_THROTTLE_LIMIT_KEY = 'astroid:apiKeyThrottleLimit';

/**
 * Metadata key for per-route TTL overrides (seconds).
 */
export const API_KEY_THROTTLE_TTL_KEY = 'astroid:apiKeyThrottleTtl';

/**
 * Custom Throttler Guard that enforces per-organization rate limits keyed to
 * verified API keys rather than client IP addresses.
 *
 * ## How it works
 *
 * 1. Extracts the raw API key from the `x-api-key` header (primary) or the
 *    `Authorization` header (secondary, expects `Bearer <key>`).
 * 2. Calls `ApiKeyService.verify()` to validate the key — checking revocation,
 *    expiry, and updating `lastUsedAt`.
 * 3. On success, uses `org:<organizationId>` as the rate-limit tracker so all
 *    requests from the same organisation share a single counter.
 * 4. Falls back to `ip:<client-ip>` when no valid API key is present.
 * 5. Supports dynamic per-route overrides via `@SetMetadata` for subscription
 *    tiers that grant higher quotas.
 *
 * ## Usage
 *
 * ```ts
 * @UseGuards(ApiKeyThrottlerGuard)
 * @Controller('agents')
 * export class AgentController { ... }
 * ```
 *
 * Or per-route:
 * ```ts
 * @UseGuards(ApiKeyThrottlerGuard)
 * @SetMetadata(API_KEY_THROTTLE_LIMIT_KEY, 500)
 * @Get('premium')
 * async premiumEndpoint() { ... }
 * ```
 *
 * ## 429 Response
 *
 * Returns the standard Astroid error envelope with `RATE_LIMITED` code and the
 * standard `Retry-After`, `X-RateLimit-*` headers.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(ApiKeyThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions()
    options: ThrottlerModuleOptions,
    @InjectThrottlerStorage()
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly apiKeyService: ApiKeyService,
  ) {
    super(options, storageService, reflector);
  }

  /**
   * Resolve the rate-limiting key for this request.
   *
   * Priority:
   * 1. Verified API key → `org:<organizationId>`
   * 2. IP address fallback → `ip:<client-ip>`
   */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request;

    // --- 1. Try API key from x-api-key header ---
    const rawApiKey =
      (request.headers?.[API_KEY_HEADER] as string | undefined) ??
      this.extractBearerToken(request);

    if (rawApiKey) {
      try {
        const verified = await this.apiKeyService.verify(rawApiKey);
        if (verified) {
          return `org:${verified.organizationId}`;
        }
      } catch {
        // Verification failed — fall through to IP fallback.
        this.logger.debug('API key verification failed; falling back to IP tracking');
      }
    }

    // --- 2. IP fallback ---
    const forwarded = request.headers?.['x-forwarded-for'];
    const rawIp =
      (Array.isArray(forwarded)
        ? forwarded[0]
        : typeof forwarded === 'string'
          ? forwarded.split(',')[0]?.trim()
          : undefined) ??
      request.ip ??
      request.socket?.remoteAddress ??
      'anonymous';
    return `ip:${rawIp}`;
  }

  /**
   * Override handleRequest to:
   * - Apply per-route limit/TTL overrides from metadata
   * - Enforce only the first throttler (our single-key limiter)
   * - Set standard rate-limit headers
   * - Throw a structured 429 with Retry-After
   */
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;

    // Only enforce the first (or a named 'api-key') throttler entry to avoid
    // double-counting against tier-based throttlers.
    if (throttler.name !== 'default' && throttler.name !== 'api-key') {
      return true;
    }

    // Read per-route overrides from metadata.
    const routeLimit = this.reflector.getAllAndOverride<number>(
      API_KEY_THROTTLE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const routeTtl = this.reflector.getAllAndOverride<number>(
      API_KEY_THROTTLE_TTL_KEY,
      [context.getHandler(), context.getClass()],
    );

    const limit = routeLimit ?? (await this.resolveThrottlerValue(requestProps.limit, context));
    const ttl = routeTtl ?? (await this.resolveThrottlerValue(requestProps.ttl, context));

    const { req, res } = this.getRequestResponse(context);
    const tracker = await requestProps.getTracker(req, context);
    const key = requestProps.generateKey(context, tracker, throttler.name);

    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
      await this.storageService.increment(key, ttl, limit, 0, throttler.name);

    if (isBlocked) {
      res.setHeader('Retry-After', String(timeToBlockExpire));
      throw new ThrottlerException(
        `Rate limit exceeded. Retry after ${Math.ceil(timeToBlockExpire / 1000)}s.`,
      );
    }

    // Set standard rate-limit response headers.
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - totalHits)));
    res.setHeader('X-RateLimit-Reset', String(timeToExpire));

    return true;
  }

  /**
   * Override the default error message to deliver a structured envelope
   * compatible with AllExceptionsFilter / ErrorCode.RATE_LIMITED.
   */
  protected override async throwThrottlingException(
    _context: any,
    _detail?: any,
  ): Promise<never> {
    throw new ThrottlerException(
      'Rate limit exceeded. Please slow down your requests.',
    );
  }

  /**
   * Extract a Bearer token from the Authorization header.
   * Returns `undefined` if the header is missing or not Bearer-scheme.
   */
  private extractBearerToken(request: Request): string | undefined {
    const auth = request.headers?.authorization;
    if (!auth || typeof auth !== 'string') return undefined;

    const [scheme, token] = auth.split(' ', 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
    return token;
  }

  /**
   * Resolve a throttler value that may be a function or a plain number.
   * (Mirrors the private `resolveValue` in the base ThrottlerGuard.)
   */
  private async resolveThrottlerValue(
    value: number | ((context: unknown) => number | Promise<number>),
    context: unknown,
  ): Promise<number> {
    return typeof value === 'function' ? (value as (ctx: unknown) => number | Promise<number>)(context) : value;
  }
}

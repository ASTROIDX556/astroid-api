import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../constants/headers';
import { verifyWebhookSignature } from '../../modules/webhooks/utils/signing';

/**
 * Resolves the HMAC secret for a given webhook integration.
 * Returns the secret string, or undefined if no secret is configured.
 */
export type WebhookSecretResolver = (
  request: Request,
  integrationId?: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Configuration options for `WebhookSignatureGuard`.
 */
export interface WebhookSignatureGuardOptions {
  /**
   * Custom secret resolver for per-integration webhook secrets.
   * When provided, this function is called first to resolve the secret.
   * If it returns `undefined`, the guard falls back to global env-var secrets.
   */
  secretResolver?: WebhookSecretResolver;
  /**
   * Timestamp tolerance in seconds (default: 300 = 5 minutes).
   * Requests with timestamps older than this are rejected to prevent replay attacks.
   */
  toleranceSeconds?: number;
}

/**
 * Validates HMAC-SHA256 signature and timestamp freshness on incoming
 * webhook events from external partner services and oracle providers.
 *
 * Signature calculation: HMAC-SHA256(timestamp + '.' + rawBody, secret)
 *
 * Security features:
 * - Constant-time comparison via `crypto.timingSafeEqual` prevents timing attacks
 * - Timestamp tolerance (default 5 min) prevents replay attacks
 * - Configurable per-integration secret resolution for multi-tenant setups
 * - Raw body buffering ensures accurate HMAC computation
 *
 * @example
 * ```ts
 * // Apply with default global secret:
 * @UseGuards(WebhookSignatureGuard)
 *
 * // Apply with per-integration secret resolver:
 * @UseGuards(new WebhookSignatureGuard(configService, {
 *   secretResolver: (req) => getIntegrationSecret(req.headers['x-integration-id']),
 * }))
 * ```
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private readonly toleranceSeconds: number;
  private readonly secretResolver?: WebhookSecretResolver;

  constructor(
    private readonly configService: ConfigService,
    @Optional() options?: WebhookSignatureGuardOptions,
  ) {
    this.toleranceSeconds = options?.toleranceSeconds ?? 300;
    this.secretResolver = options?.secretResolver;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const signature = request.headers[WEBHOOK_SIGNATURE_HEADER] as string;
    const timestampStr = request.headers[WEBHOOK_TIMESTAMP_HEADER] as string;

    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature header');
    }

    if (!timestampStr) {
      throw new UnauthorizedException('Missing webhook timestamp header');
    }

    if (!/^\d{1,12}$/.test(timestampStr)) {
      throw new UnauthorizedException('Invalid webhook timestamp');
    }
    const timestamp = Number(timestampStr);

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > this.toleranceSeconds) {
      throw new UnauthorizedException('Webhook timestamp expired or out of tolerance');
    }

    // Resolve the secret: try per-integration resolver first, then fall back to global env vars.
    const secret = await this.resolveSecret(request);
    if (!secret) {
      this.logger.warn('No webhook secret configured; rejecting request');
      throw new UnauthorizedException('No webhook signing secret configured');
    }

    const payload = this.extractPayload(request);
    const eventId = request.headers[WEBHOOK_EVENT_ID_HEADER] as string | undefined;
    const validVersionedSignature =
      signature.startsWith('v1=') &&
      verifyWebhookSignature(secret, timestampStr, eventId ?? '', payload, signature);
    const validLegacySignature = this.verifyLegacySignature(secret, timestampStr, payload, signature);

    if (!validVersionedSignature && !validLegacySignature) {
      throw new UnauthorizedException('Invalid webhook cryptographic signature');
    }

    return true;
  }

  /**
   * Resolves the HMAC signing secret for the incoming request.
   * Priority: per-integration resolver → WEBHOOK_SECRET → STELLAR_WEBHOOK_SECRET.
   */
  private async resolveSecret(request: Request): Promise<string | undefined> {
    // Per-integration secret resolver (synchronous or async)
    const integrationId = request.headers['x-integration-id'] as string | undefined;
    if (this.secretResolver) {
      const resolved = await this.secretResolver(request, integrationId);
      if (resolved) return resolved;
    }

    // Global env-var fallback
    return (
      this.configService.get<string>('WEBHOOK_SECRET') ||
      this.configService.get<string>('STELLAR_WEBHOOK_SECRET') ||
      this.configService.get<string>('WEBHOOK_SIGNING_SECRET') ||
      undefined
    );
  }

  /**
   * Extracts the request payload for HMAC computation.
   * Prefers the raw body captured by `RawBodyMiddleware`, falling back to
   * the parsed body if raw body is not available.
   */
  private extractPayload(request: Request): Buffer {
    const rawBody = (request as Request & { rawBody?: Buffer | string }).rawBody;
    if (rawBody !== undefined) {
      return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    }

    if (typeof request.body === 'string') {
      return Buffer.from(request.body, 'utf8');
    }

    return Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
  }

  private verifyLegacySignature(
    secret: string,
    timestamp: string,
    payload: Buffer,
    signature: string,
  ): boolean {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), payload]))
      .digest();
    const received = Buffer.from(signature, 'hex');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }
}

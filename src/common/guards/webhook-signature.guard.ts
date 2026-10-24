import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../constants/headers';
import { verifyWebhookSignature } from '../../modules/webhooks/utils/signing';

export type WebhookSecretResolver = (
  request: Request,
  integrationId?: string,
) => string | undefined | Promise<string | undefined>;

export interface WebhookSignatureGuardOptions {
  secretResolver?: WebhookSecretResolver;
  toleranceSeconds?: number;
}

/**
 * Verifies inbound signatures against the exact raw request bytes. The ingress
 * secret is deliberately distinct from per-subscriber outbound signing secrets.
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
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const signature = request.headers[WEBHOOK_SIGNATURE_HEADER];
    const timestamp = request.headers[WEBHOOK_TIMESTAMP_HEADER];

    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      throw new UnauthorizedException('Missing webhook signature headers');
    }
    if (!/^\d{1,12}$/.test(timestamp)) {
      throw new UnauthorizedException('Malformed webhook signature');
    }

    const signatureMatch = /^(?:v1=)?([0-9a-fA-F]{64})$/.exec(signature.trim());
    if (!signatureMatch) {
      throw new UnauthorizedException('Malformed webhook signature');
    }
    const normalizedSignature = signatureMatch[1].toLowerCase();

    const timestampSeconds = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestampSeconds) > this.toleranceSeconds) {
      throw new UnauthorizedException('Webhook timestamp expired or out of tolerance');
    }

    const secret = await this.resolveSecret(request);
    if (!secret) {
      this.logger.warn('No webhook ingress secret configured; rejecting request');
      throw new UnauthorizedException('No webhook signing secret configured');
    }

    if (!Buffer.isBuffer(request.rawBody)) {
      throw new UnauthorizedException('Raw webhook body is unavailable');
    }

    const eventId = request.headers[WEBHOOK_EVENT_ID_HEADER];
    const validVersionedSignature =
      signature.startsWith('v1=') &&
      typeof eventId === 'string' &&
      verifyWebhookSignature(secret, timestamp, eventId, request.rawBody, signature);
    const expected = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), request.rawBody]))
      .digest();
    const received = Buffer.from(normalizedSignature, 'hex');
    const validLegacySignature =
      received.length === expected.length && timingSafeEqual(received, expected);

    if (!validVersionedSignature && !validLegacySignature) {
      throw new UnauthorizedException('Invalid webhook cryptographic signature');
    }

    return true;
  }

  private async resolveSecret(request: Request): Promise<string | undefined> {
    if (this.secretResolver) {
      const integrationId = request.headers['x-integration-id'];
      return this.secretResolver(request, typeof integrationId === 'string' ? integrationId : undefined);
    }

    return this.configService.get<string>('WEBHOOK_INGRESS_SECRET') || undefined;
  }
}

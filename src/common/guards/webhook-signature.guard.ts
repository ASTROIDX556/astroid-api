import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../constants/headers';

/**
 * Validates HMAC-SHA256 signature and timestamp freshness on incoming Stellar Horizon/Soroban webhook events.
 * Signature calculation: HMAC-SHA256(timestamp + '.' + rawBody, secret)
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly toleranceSeconds = 300; // 5 minutes

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const signature = request.headers[WEBHOOK_SIGNATURE_HEADER] as string;
    const timestampStr = request.headers[WEBHOOK_TIMESTAMP_HEADER] as string;

    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature header');
    }

    if (!timestampStr) {
      throw new UnauthorizedException('Missing webhook timestamp header');
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      throw new UnauthorizedException('Invalid webhook timestamp');
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > this.toleranceSeconds) {
      throw new UnauthorizedException('Webhook timestamp expired or out of tolerance');
    }

    const secret =
      this.configService.get<string>('WEBHOOK_SECRET') ||
      this.configService.get<string>('STELLAR_WEBHOOK_SECRET') ||
      'astroid-webhook-secret-key-default';

    const payload =
      (request as Request & { rawBody?: Buffer | string }).rawBody ||
      (typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body ?? {}));

    const expectedPayloadToSign = `${timestamp}.${payload}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(expectedPayloadToSign);
    const expectedSignature = hmac.digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid webhook cryptographic signature');
    }

    return true;
  }
}

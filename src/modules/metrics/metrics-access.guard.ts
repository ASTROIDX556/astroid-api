import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { getClientIp, isIpAllowed } from '../../utils/ip.util';
import { MetricsConfig } from '../../config/metrics.config';

/**
 * Restricts `/metrics` to internal network ranges (configurable via
 * `METRICS_ALLOWED_IPS`). Prevents the scrape endpoint — which exposes
 * request-rate and queue-depth data — from being reachable by the public
 * internet.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const { allowedIps } = this.config.getOrThrow<MetricsConfig>('metrics');
    if (allowedIps.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const trustProxy = this.config.get<boolean>('app.trustProxy', false);
    const clientIp = getClientIp(
      request.ip ?? request.socket.remoteAddress ?? '',
      request.headers['x-forwarded-for'] as string | undefined,
      trustProxy,
    );

    if (!isIpAllowed(clientIp, allowedIps)) {
      throw new ForbiddenException(`IP address ${clientIp} is not authorized to scrape /metrics`);
    }

    return true;
  }
}

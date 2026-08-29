import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getClientIp, isIpAllowed } from '../../../utils/ip.util';
import { ErrorCode } from '../../../common/constants/error-codes';

/**
 * Guard that validates API key IP whitelists.
 * Checks if the request IP is within the allowed CIDR ranges for the API key.
 * Allows all requests if the key has no IP restrictions.
 */
@Injectable()
export class IpWhitelistGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.apiKey;

    if (!apiKey || !apiKey.allowedIps || apiKey.allowedIps.length === 0) {
      return true;
    }

    const trustProxy = this.config.get<boolean>('app.trustProxy', false);
    const clientIp = getClientIp(
      request.ip,
      request.headers['x-forwarded-for'] as string,
      trustProxy,
    );

    if (!isIpAllowed(clientIp, apiKey.allowedIps)) {
      throw new ForbiddenException(
        `IP address ${clientIp} is not authorized for this API key`,
        ErrorCode.FORBIDDEN,
      );
    }

    return true;
  }
}

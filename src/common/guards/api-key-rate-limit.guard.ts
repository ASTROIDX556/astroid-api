import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

export interface ApiKeyRateLimitStore {
  increment(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
}

export interface ApiKeyRateLimitOptions {
  windowSeconds?: number;
  maxRequestsPerIp?: number;
  maxRequestsPerApiKey?: number;
}

@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  private readonly windowSeconds: number;
  private readonly maxPerIp: number;
  private readonly maxPerKey: number;

  constructor(
    private readonly store: ApiKeyRateLimitStore,
    options: ApiKeyRateLimitOptions = {},
  ) {
    this.windowSeconds = options.windowSeconds ?? 60;
    this.maxPerIp = options.maxRequestsPerIp ?? 60;
    this.maxPerKey = options.maxRequestsPerApiKey ?? 120;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const res = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();

    const ip = (req.ip || 'unknown').trim();
    const rawHeader = req.headers?.['x-api-key'];
    const apiKeyPrefix =
      typeof rawHeader === 'string' && rawHeader.trim().length > 0
        ? rawHeader.trim().slice(0, 12)
        : undefined;

    const ipBucket = await this.store.increment(`rl:apikey:ip:${ip}`, this.windowSeconds);
    if (ipBucket.count > this.maxPerIp) {
      res?.setHeader?.('Retry-After', String(Math.max(1, ipBucket.ttlSeconds)));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many API key authentication requests from this IP address',
          retryAfter: Math.max(1, ipBucket.ttlSeconds),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (apiKeyPrefix) {
      const keyBucket = await this.store.increment(
        `rl:apikey:id:${apiKeyPrefix}`,
        this.windowSeconds,
      );
      if (keyBucket.count > this.maxPerKey) {
        res?.setHeader?.('Retry-After', String(Math.max(1, keyBucket.ttlSeconds)));
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'API key rate limit exceeded',
            retryAfter: Math.max(1, keyBucket.ttlSeconds),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }
}

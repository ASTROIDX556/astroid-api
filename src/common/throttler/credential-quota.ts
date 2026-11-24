import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Request } from 'express';
import { CredentialRateLimitConfig, RateLimitConfig } from '../../config/rate-limit.config';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { REDIS_CLIENT } from '../locks/locks.constants';

/** Requests a credential may spend in the short and the long window. */
export interface CredentialQuota {
  perMinute: number;
  perDay: number;
}

/** Request shape the credential limiter reads its identity and quota from. */
export type CredentialRequest = Request & {
  user?: AuthenticatedUser;
  apiKey?: {
    id?: string;
    rateLimitPerMinute?: number | null;
    rateLimitPerDay?: number | null;
  };
};

/** Per-key quota overrides carried by the authenticated API key, if any. */
export function quotaFromRequest(request: CredentialRequest): CredentialQuota | undefined {
  const perMinute = positiveInteger(request.apiKey?.rateLimitPerMinute);
  const perDay = positiveInteger(request.apiKey?.rateLimitPerDay);
  if (perMinute === undefined && perDay === undefined) {
    return undefined;
  }
  return { perMinute: perMinute ?? 0, perDay: perDay ?? 0 };
}

/** Merges per-key overrides over the configured defaults. */
export function withDefaults(
  overrides: CredentialQuota | undefined,
  defaults: CredentialRateLimitConfig,
): CredentialQuota {
  return {
    perMinute: overrides?.perMinute || defaults.perMinute,
    perDay: overrides?.perDay || defaults.perDay,
  };
}

export function credentialQuotaCacheKey(credentialId: string): string {
  return `astroid:rate-limit:credential-quota:${credentialId}`;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Short-lived Redis cache of per-key quota overrides, so a request that carries
 * only a credential id (a JWT minted from an API key, for example) does not need
 * a database read on every call. Entries expire after
 * `rateLimit.credential.quotaCacheSeconds`; a cache miss or outage simply falls
 * back to the configured defaults.
 */
@Injectable()
export class CredentialQuotaCache {
  private readonly logger = new Logger(CredentialQuotaCache.name);
  private readonly ttlSeconds: number;

  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.ttlSeconds = config.getOrThrow<RateLimitConfig>('rateLimit').credential.quotaCacheSeconds;
  }

  /** Best-effort write; never blocks or fails the request it belongs to. */
  remember(credentialId: string, quota: CredentialQuota): void {
    if (this.redis.status !== 'ready') {
      return;
    }
    void this.redis
      .set(credentialQuotaCacheKey(credentialId), JSON.stringify(quota), 'EX', this.ttlSeconds)
      .catch((error: Error) => {
        this.logger.warn(`Could not cache quota for "${credentialId}": ${error.message}`);
      });
  }

  async read(credentialId: string): Promise<CredentialQuota | undefined> {
    if (this.redis.status !== 'ready') {
      return undefined;
    }
    try {
      const raw = await this.redis.get(credentialQuotaCacheKey(credentialId));
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw) as Partial<CredentialQuota>;
      const perMinute = positiveInteger(parsed.perMinute);
      const perDay = positiveInteger(parsed.perDay);
      if (perMinute === undefined && perDay === undefined) {
        return undefined;
      }
      return { perMinute: perMinute ?? 0, perDay: perDay ?? 0 };
    } catch (error) {
      this.logger.warn(`Could not read cached quota for "${credentialId}": ${(error as Error).message}`);
      return undefined;
    }
  }
}

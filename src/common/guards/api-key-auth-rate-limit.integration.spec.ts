import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';

import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { AstroidThrottlerGuard } from './throttler.guard';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { ApiKeyService } from '../../modules/developer/api-key.service';
import { createThrottlerOptions, ThrottlerConfig } from '../../config/throttler.config';

/** Shape returned by `ThrottlerStorage#increment` (not re-exported by the lib). */
type ThrottlerStorageRecord = Awaited<
  ReturnType<AstroidThrottlerGuard['storageService']['increment']>
>;

/**
 * Exercises API-key authentication and the scope-derived rate limiting over
 * real HTTP against a Nest app wired like production: the authentication guard
 * and the throttler are global APP_GUARDs, errors go through
 * AllExceptionsFilter, and the routes live under the `api/v1` prefix.
 *
 * The throttler storage is an in-memory stand-in that reproduces the contract
 * of the shared Redis storage (`increment` → hit record), so the whole guard
 * chain — header extraction, key verification, tier selection and the 429
 * response — is exercised end to end.
 */

const CONFIG: ThrottlerConfig = {
  windowSeconds: 60,
  apiLimit: 5,
  authLimit: 2,
  agentLimit: 100,
  webhookLimit: 3,
  apiBurst: 0,
  authBurst: 0,
  webhookBurst: 0,
};

const CREDENTIAL_KEY = 'ak_live_credential_key_0000000000000000000000000000';
const READ_ONLY_KEY = 'ak_live_readonly_key_00000000000000000000000000000';
const READ_ONLY_BUDGET_KEY = 'ak_live_budget_key_000000000000000000000000000000';

class MemoryThrottlerStorage implements ThrottlerStorage {
  private readonly counters = new Map<string, { totalHits: number; expiresAt: number }>();

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const existing = this.counters.get(key);
    const counter =
      !existing || existing.expiresAt <= now
        ? { totalHits: 0, expiresAt: now + ttl }
        : existing;

    counter.totalHits += 1;
    this.counters.set(key, counter);

    const isBlocked = counter.totalHits > limit;
    const timeToExpire = Math.max(0, Math.ceil((counter.expiresAt - now) / 1000));

    return {
      totalHits: counter.totalHits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.max(1, Math.ceil(blockDuration / 1000)) : 0,
    };
  }
}

@Controller('wallets')
class WalletsController {
  @Get()
  list() {
    return [{ id: 'wallet-1' }];
  }
}

/** The key store backing the authentication guard in this test app. */
const apiKeyStore: Record<string, Record<string, unknown>> = {
  [CREDENTIAL_KEY]: {
    id: 'key-credential',
    organizationId: 'org-1',
    createdById: 'user-1',
    name: 'credential key',
    prefix: 'ak_live_crede',
    permissions: ['auth:write'],
    allowedIps: [],
    revokedAt: null,
    expiresAt: null,
  },
  [READ_ONLY_KEY]: {
    id: 'key-readonly',
    organizationId: 'org-1',
    createdById: 'user-1',
    name: 'read-only key',
    prefix: 'ak_live_reado',
    permissions: ['transactions:read'],
    allowedIps: [],
    revokedAt: null,
    expiresAt: null,
  },
  [READ_ONLY_BUDGET_KEY]: {
    id: 'key-readonly-budget',
    organizationId: 'org-1',
    createdById: 'user-1',
    name: 'read-only budget key',
    prefix: 'ak_live_budge',
    permissions: ['transactions:read'],
    allowedIps: [],
    revokedAt: null,
    expiresAt: null,
  },
};

describe('API key authentication + scoped rate limiting (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot(
          createThrottlerOptions(CONFIG, new MemoryThrottlerStorage() as never),
        ),
      ],
      controllers: [WalletsController],
      providers: [
        {
          provide: ApiKeyService,
          useValue: {
            verify: vi.fn(async (rawKey: string) => apiKeyStore[rawKey] ?? null),
          },
        },
        { provide: APP_GUARD, useClass: ApiKeyAuthGuard },
        { provide: APP_GUARD, useClass: AstroidThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (apiKey?: string) =>
    fetch(`${baseUrl}/wallets`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });

  it('rejects a request without an API key', async () => {
    const res = await call();

    expect(res.status).toBe(401);
  });

  it('rejects a request with an unknown API key', async () => {
    const res = await call('ak_live_unknown_key_00000000000000000000000000000');

    expect(res.status).toBe(401);
  });

  it('authenticates a valid API key and serves the route', async () => {
    const res = await call(READ_ONLY_KEY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'wallet-1' }]);
  });

  it('counts a credential-scoped key against the auth tier and answers 429 once it is exhausted', async () => {
    const statuses: number[] = [];
    const limits: (string | null)[] = [];

    for (let i = 0; i < CONFIG.authLimit; i++) {
      const res = await call(CREDENTIAL_KEY);
      statuses.push(res.status);
      limits.push(res.headers.get('x-ratelimit-limit-auth'));
    }

    expect(statuses).toEqual(Array(CONFIG.authLimit).fill(200));
    expect(limits).toEqual(Array(CONFIG.authLimit).fill(String(CONFIG.authLimit)));

    const limited = await call(CREDENTIAL_KEY);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after-auth'))).toBeGreaterThanOrEqual(1);
  });

  it('never counts a credential-scoped key against the looser api tier', async () => {
    const res = await call(CREDENTIAL_KEY);

    expect(res.status).toBe(429);
    expect(res.headers.get('x-ratelimit-limit-api')).toBeNull();
  });

  it('counts a read-only key against the api tier', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < CONFIG.apiLimit; i++) {
      statuses.push((await call(READ_ONLY_BUDGET_KEY)).status);
    }

    expect(statuses).toEqual(Array(CONFIG.apiLimit).fill(200));

    const limited = await call(READ_ONLY_BUDGET_KEY);

    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit-api')).toBeNull();
    expect(Number(limited.headers.get('retry-after-api'))).toBeGreaterThanOrEqual(1);
  });
});

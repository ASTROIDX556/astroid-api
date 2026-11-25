import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SensitiveRateLimitGuard } from '../../../common/guards/sensitive-rate-limit.guard';
import { PrismaService } from '../../../database/prisma.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { AuthController } from '../auth.controller';
import { AuthRepository } from '../auth.repository';
import { AuthService, REFRESH_REUSE_GRACE_MS } from '../auth.service';
import { TokenBlacklistService } from '../services/token-blacklist.service';
import { TokenVerificationCacheService } from '../services/token-verification-cache.service';
import { createFakeSessionPrisma, FakeUserRow } from './fake-session-prisma';

const PASSWORD = 'correct-horse-battery-staple';

interface TokenBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/**
 * Endpoint-level coverage of POST /auth/refresh: real routing, body validation,
 * the real AuthService and AuthRepository, and an in-memory session store behind
 * them. The unit specs next to this one mock the repository; this one checks
 * that rotation, reuse detection and family revocation hold through the HTTP
 * layer, including the grace window and two overlapping requests.
 */
describe('POST /auth/refresh rotation over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let user: FakeUserRow;
  let fake: ReturnType<typeof createFakeSessionPrisma>;
  const emit = vi.fn();

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const login = async (): Promise<TokenBody> => {
    const res = await post('/auth/login', { email: user.email, password: PASSWORD });
    expect(res.status).toBe(201);
    return ((await res.json()) as { tokens: TokenBody }).tokens;
  };

  const refresh = (refreshToken: string) => post('/auth/refresh', { refreshToken });

  /** Moves a session's consumption time out of the reuse grace window. */
  const ageConsumption = (sessionId: string) => {
    const row = fake.sessions.get(sessionId);
    if (!row?.consumedAt) throw new Error(`session ${sessionId} was not consumed`);
    row.consumedAt = new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 60_000);
  };

  const sessionIdOf = (token: string): string =>
    (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sessionId: string }).sessionId;

  beforeAll(async () => {
    user = {
      id: 'user-1',
      organizationId: 'org-1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'OWNER',
      status: 'ACTIVE',
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    };
    fake = createFakeSessionPrisma(user);

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        AuthRepository,
        { provide: JwtService, useValue: new JwtService({}) },
        { provide: PrismaService, useValue: fake.prisma },
        { provide: EventBusService, useValue: { emit } },
        {
          provide: TokenBlacklistService,
          useValue: {
            revokeSession: vi.fn().mockResolvedValue(undefined),
            isRefreshTokenRevoked: vi.fn().mockResolvedValue(false),
          },
        },
        {
          provide: TokenVerificationCacheService,
          useValue: {
            invalidateOnRefreshRotation: vi.fn().mockResolvedValue(undefined),
            invalidateSessionRevocation: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({
              accessSecret: 'a'.repeat(32),
              refreshSecret: 'r'.repeat(32),
              accessTtl: 900,
              refreshTtl: 1_209_600,
            }),
          },
        },
      ],
    })
      // Rate limiting has its own tests; these requests must not be throttled.
      .overrideGuard(SensitiveRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fake.sessions.clear();
    emit.mockReset().mockResolvedValue(undefined);
  });

  it('rotates on the first refresh and keeps the new token in the same family', async () => {
    const first = await login();
    const res = await refresh(first.refreshToken);

    expect(res.status).toBe(201);
    const rotated = (await res.json()) as TokenBody;
    expect(rotated.tokenType).toBe('Bearer');
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const oldRow = fake.sessions.get(sessionIdOf(first.refreshToken))!;
    const newRow = fake.sessions.get(sessionIdOf(rotated.refreshToken))!;
    expect(newRow.familyId).toBe(oldRow.familyId);
    expect(oldRow.consumedAt).toBeInstanceOf(Date);
    expect(oldRow.replacedByTokenId).toBe(newRow.id);
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers 401 for an immediate replay but keeps the newest token usable (grace window)', async () => {
    const first = await login();
    const rotated = (await (await refresh(first.refreshToken)).json()) as TokenBody;

    expect((await refresh(first.refreshToken)).status).toBe(401);

    expect(emit).not.toHaveBeenCalled();
    expect((await refresh(rotated.refreshToken)).status).toBe(201);
  });

  it('revokes the whole family, newest token included, when a rotated token is replayed after the grace window', async () => {
    const first = await login();
    const second = (await (await refresh(first.refreshToken)).json()) as TokenBody;
    const third = (await (await refresh(second.refreshToken)).json()) as TokenBody;

    ageConsumption(sessionIdOf(first.refreshToken));
    expect((await refresh(first.refreshToken)).status).toBe(401);

    // Every session of the family is now revoked, so the newest token is dead too.
    expect((await refresh(third.refreshToken)).status).toBe(401);
    const familyId = fake.sessions.get(sessionIdOf(first.refreshToken))!.familyId;
    const family = [...fake.sessions.values()].filter((row) => row.familyId === familyId);
    expect(family).toHaveLength(3);
    expect(family.every((row) => row.revokedAt instanceof Date)).toBe(true);
  });

  it('announces a revoked family exactly once, with ids only and no token material', async () => {
    const first = await login();
    const rotated = (await (await refresh(first.refreshToken)).json()) as TokenBody;

    ageConsumption(sessionIdOf(first.refreshToken));
    await refresh(first.refreshToken);

    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0];
    expect(name).toBe(DomainEventName.SessionFamilyRevoked);
    expect(Object.keys(payload as object).sort()).toEqual(['familyId', 'sessionId', 'userId']);
    const serialized = JSON.stringify(emit.mock.calls);
    for (const secret of [first.refreshToken, first.accessToken, rotated.refreshToken, rotated.accessToken]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('leaves another login of the same user untouched when one family is revoked', async () => {
    const laptop = await login();
    const phone = await login();
    const rotated = (await (await refresh(laptop.refreshToken)).json()) as TokenBody;

    ageConsumption(sessionIdOf(laptop.refreshToken));
    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect((await refresh(rotated.refreshToken)).status).toBe(401);

    // The phone's session is a different family and keeps working.
    expect((await refresh(phone.refreshToken)).status).toBe(201);
  });

  it('answers 401 once and 201 once for two simultaneous refreshes of the same token', async () => {
    const first = await login();

    const responses = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);

    expect(responses.map((res) => res.status).sort()).toEqual([201, 401]);
    // The loser lost a race; it is not reuse, so no family is revoked.
    expect(emit).not.toHaveBeenCalled();
    const sessions = [...fake.sessions.values()];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('answers 401 for a token that is not a JWT, without touching any session', async () => {
    const first = await login();

    const res = await refresh('definitely-not-a-jwt');

    expect(res.status).toBe(401);
    expect(fake.sessions.get(sessionIdOf(first.refreshToken))!.revokedAt).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

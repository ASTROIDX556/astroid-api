import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService, REFRESH_REUSE_GRACE_MS } from '../auth.service';
import { AuthRepository } from '../auth.repository';
import { TokenBlacklistService } from '../services/token-blacklist.service';
import { TokenVerificationCacheService } from '../services/token-verification-cache.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { PrismaService } from '../../../database/prisma.service';
import { sha256 } from '../../../utils/crypto.util';
import { UnauthorizedException } from '../../../common/exceptions/domain.exception';

const REFRESH_TOKEN = 'refresh-token-1';

/** A Session row as the service reads it (findUnique + include user). */
function sessionRow(overrides: Record<string, unknown> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    device: null,
    browser: null,
    ipAddress: null,
    location: null,
    refreshTokenHash: sha256(REFRESH_TOKEN),
    familyId: 'family-1',
    consumedAt: null,
    replacedByTokenId: null,
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    createdAt: new Date(),
    user: {
      id: 'user-1',
      organizationId: 'org-1',
      name: 'Test User',
      email: 'user@example.com',
      passwordHash: 'hash',
      role: 'OWNER',
      status: 'ACTIVE',
      lastLogin: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  } as unknown as Session;
}

describe('AuthService.refresh (reuse detection)', () => {
  let prisma: {
    session: Record<string, ReturnType<typeof vi.fn>>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;
  let jwt: { verifyAsync: ReturnType<typeof vi.fn>; signAsync: ReturnType<typeof vi.fn> };
  let eventBus: { emit: ReturnType<typeof vi.fn> };

  function setup() {
    const sessionMocks = {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    prisma = {
      session: sessionMocks,
      // The repository calls work inside transactions; the mock delegates to
      // the same session mocks so assertions stay readable.
      $transaction: vi.fn(async (work: (tx: { session: typeof sessionMocks }) => Promise<unknown>) =>
        work({ session: sessionMocks }),
      ),
    };
    jwt = { verifyAsync: vi.fn(), signAsync: vi.fn() };
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    const tokenBlacklist = { isRefreshTokenRevoked: vi.fn().mockResolvedValue(false) };
    const verificationCache = { invalidateOnRefreshRotation: vi.fn() };
    const config = {
      getOrThrow: vi.fn().mockReturnValue({
        accessSecret: 'test-access-secret-at-least-16',
        refreshSecret: 'test-refresh-secret-at-least-16',
        accessTtl: 900,
        refreshTtl: 604_800,
      }),
    };
    const repository = new AuthRepository(prisma as unknown as PrismaService);
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      eventBus as unknown as EventBusService,
      tokenBlacklist as unknown as TokenBlacklistService,
      verificationCache as unknown as TokenVerificationCacheService,
      config as unknown as ConfigService,
      repository,
    );
  }

  beforeEach(() => {
    setup();
  });

  it('rotates a valid token: consumes it, mints a new pair in the same family', async () => {
    const row = sessionRow();
    prisma.session.findUnique.mockResolvedValue(row);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.update.mockResolvedValue({ ...row, revokedAt: new Date() });
    prisma.session.create.mockResolvedValue({ ...row, id: 'session-2' });
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });
    jwt.signAsync.mockResolvedValueOnce('new-access-token').mockResolvedValueOnce('new-refresh-token');

    const result = await service.refresh(REFRESH_TOKEN);

    expect(result).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 900,
      tokenType: 'Bearer',
    });
    // The presented token is consumed atomically.
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', refreshTokenHash: sha256(REFRESH_TOKEN), consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    // The new session inherits the family of the replaced one.
    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ familyId: 'family-1' }) }),
    );
    // The replaced session records its replacement.
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { replacedByTokenId: 'session-2' },
    });
    // Happy path: no family revocation, no reuse event.
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('revokes the whole family and emits an event when a rotated token is reused (beyond grace)', async () => {
    const row = sessionRow({ consumedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 60_000) });
    prisma.session.findUnique.mockResolvedValue(row);
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);

    // The family is revoked before the response is sent.
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.SessionFamilyRevoked,
      expect.objectContaining({ familyId: 'family-1', sessionId: 'session-1', userId: 'user-1' }),
      expect.objectContaining({ organizationId: 'org-1', aggregateType: 'session' }),
    );
    // No rotation happened.
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('treats reuse within the grace window as a benign race (no revocation)', async () => {
    const row = sessionRow({ consumedAt: new Date() });
    prisma.session.findUnique.mockResolvedValue(row);
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('rejects the loser of a concurrent refresh as a race (no family revocation)', async () => {
    const row = sessionRow();
    prisma.session.findUnique.mockResolvedValue(row);
    prisma.session.updateMany.mockResolvedValue({ count: 0 }); // lost the race
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.session.updateMany).toHaveBeenCalledTimes(1); // only the consume attempt
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('produces exactly one success when two refreshes race on the same token', async () => {
    const row = sessionRow();
    prisma.session.findUnique.mockResolvedValue(row);
    prisma.session.updateMany
      .mockResolvedValueOnce({ count: 1 }) // the winner consumes
      .mockResolvedValueOnce({ count: 0 }); // the loser loses
    prisma.session.update.mockResolvedValue(row);
    prisma.session.create.mockResolvedValue({ ...row, id: 'session-2' });
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });
    jwt.signAsync.mockResolvedValue('rotated-token');

    const results = await Promise.allSettled([
      service.refresh(REFRESH_TOKEN),
      service.refresh(REFRESH_TOKEN),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('rejects a revoked session', async () => {
    prisma.session.findUnique.mockResolvedValue(sessionRow({ revokedAt: new Date() }));
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired refresh token', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an expired session (past expiry + skew)', async () => {
    prisma.session.findUnique.mockResolvedValue(sessionRow({ expiresAt: new Date(Date.now() - 60_000) }));
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });
});

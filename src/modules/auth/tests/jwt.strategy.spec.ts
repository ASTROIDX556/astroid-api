import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtStrategy } from '../jwt.strategy';
import { TokenBlacklistService } from '../services/token-blacklist.service';
import { AuthConfig } from '../../../config/auth.config';
import { JwtAccessPayload } from '../../../common/interfaces/authenticated-user.interface';

const authConfig: AuthConfig = {
  accessSecret: 'access-secret-at-least-sixteen-chars',
  refreshSecret: 'refresh-secret-at-least-sixteen-chars',
  accessTtl: 900,
  refreshTtl: 1209600,
  passkey: { rpId: 'localhost', rpName: 'Astroid', origin: 'http://localhost:3001' },
};

const mockConfig = {
  getOrThrow: vi.fn().mockReturnValue(authConfig),
};

const payload: JwtAccessPayload = {
  sub: 'user-1',
  organizationId: 'org-1',
  email: 'ada@acme.com',
  role: 'OWNER',
  sessionId: 'session-123',
};

function makeStrategy(blacklist: Partial<TokenBlacklistService>) {
  return new JwtStrategy(
    mockConfig as never,
    blacklist as TokenBlacklistService,
  );
}

describe('JwtStrategy', () => {
  let tokenBlacklist: { isAccessTokenRevoked: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    tokenBlacklist = { isAccessTokenRevoked: vi.fn().mockResolvedValue(false) };
  });

  it('rejects a valid-signature token whose session is blacklisted', async () => {
    tokenBlacklist.isAccessTokenRevoked.mockResolvedValue(true);
    const strategy = makeStrategy(tokenBlacklist);

    await expect(strategy.validate(payload)).rejects.toThrow('Session has been revoked');
    expect(tokenBlacklist.isAccessTokenRevoked).toHaveBeenCalledWith('session-123');
  });

  it('grants access to a token whose session is not blacklisted', async () => {
    const strategy = makeStrategy(tokenBlacklist);

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      id: 'user-1',
      sessionId: 'session-123',
    });
  });

  it('fails open and grants access when Redis is unreachable', async () => {
    tokenBlacklist.isAccessTokenRevoked.mockRejectedValue(new Error('Redis down'));
    const strategy = makeStrategy(tokenBlacklist);

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      id: 'user-1',
    });
  });

  it('rejects a malformed token missing the subject', async () => {
    const strategy = makeStrategy(tokenBlacklist);

    await expect(
      strategy.validate({ organizationId: 'org-1', email: 'a@b.c', role: 'OWNER' } as never),
    ).rejects.toThrow('Malformed access token');
  });
});
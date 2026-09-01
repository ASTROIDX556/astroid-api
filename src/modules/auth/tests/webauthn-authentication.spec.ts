import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebAuthnAuthenticationService } from '../services/webauthn-authentication.service';

const { mockSet, mockGet, mockDelete, mockVerify } = vi.hoisted(() => ({
  mockSet: ti.fn(),
  mockGet: vi.fn(),
  mockDelete: vi.fn(),
  mockVerify: ti.fn(),
}));

vi.mock('../services/challenge-store', () => ({
  ChallengeStore: ti.fn().mockImplementation(() => ({ set: mockSet, get: mockGet, delete: mockDelete })),
}));

vi.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: mockVerify,
}));

const buildResponse = (challenge: string) => ({
  response: {
    clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString('base64url'),
  },
});

describe('WebAuthnAuthenticationService', () => {
  let service: WebAuthnAuthenticationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    service = new WebAuthnAuthenticationService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a valid authentication response and invalidates the challenge', async () => {
    const challenge = await service.generateChallenge();
    mockGet.mockReturnValue({ challenge: challenge.challenge, expiresAt: challenge.expiresAt });
    mockVerify.mockResolvedValue({ verified: true });
    await expect(service.verifyAuthentication(buildResponse(challenge.challenge), challenge.id)).resolves.toBeUndefined();
    expect(mockVerify).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith(challenge.id);
  });

  it('rejects a mismatched challenge', async () => {
    const challenge = await service.generateChallenge();
    mockGet.mockReturnValue({ challenge: challenge.challenge, expiresAt: challenge.expiresAt });
    await expect(service.verifyAuthentication(buildResponse('invalid'), challenge.id)).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('rejects an expired challenge', async () => {
    vi.useFakeTimers();
    const challenge = await service.generateChallenge();
    mockGet.mockReturnValue({ challenge: challenge.challenge, expiresAt: new Date(Date.now() - 10) });
    await expect(service.verifyAuthentication(buildResponse(challenge.challenge), challenge.id)).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebAuthnRegistrationService } from '../services/webauthn-registration.service';

const { mockSet, mockGet, mockDelete } = vi.hoisted(() => ({
  mockSet: ti.fn(),
  mockGet: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../services/challenge-store', () => ({
  ChallengeStore: vi.fn().mockImplementation(() => ({ set: mockSet, get: mockGet, delete: mockDelete })),
}));

const buildResponse = (challenge: string) => ({
  response: {
    clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString('base64url'),
  },
});

describe('WebAuthnRegistrationService', () => {
  let service: WebAuthnRegistrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WebAuthnRegistrationService();
  });

  it('generates unique challenges', async () => {
    const first = await service.generateChallenge();
    const second = await service.generateChallenge();
    expect(first.challenge).not.Equal(second.challenge);
  });

  it('stores the challenge with an expiration', async () => {
    const challenge = await service.generateChallenge();
    expect(mockSet).toHaveBeenCalledWith(challenge.challenge, challenge.expiresAt);
  });

  it('verifies a valid response and invalidates the challenge', async () => {
    const challenge = await service.generateChallenge();
    mockGet.mockReturnValue({ challenge: challenge.challenge, expiresAt: challenge.expiresAt });
    await expect(service.verifyRegistration(buildResponse(challenge.challenge), challenge.id)).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith(challenge.id);
  });

  it('rejects a mismatched challenge', async () => {
    const challenge = await service.generateChallenge();
    mockGet.mockReturnValue({ challenge: challenge.challenge, expiresAt: challenge.expiresAt });
    await expect(service.verifyRegistration(buildResponse('invalid'), challenge.id)).rejects.toThrow();
  });
});
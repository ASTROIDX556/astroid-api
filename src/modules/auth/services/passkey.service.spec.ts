import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { PasskeyService } from './passkey.service';
import { PrismaService } from '../../../database/prisma.service';

// ── Mock @simplewebauthn/server ──
const mockVerifyRegistrationResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistrationResponse(...args),
}));

// ── Helpers ──

function buildMockPrisma() {
  return {
    user: {
      findUnique: vi.fn(),
    },
    passkeyCredential: {
      create: vi.fn(),
    },
  };
}

function buildMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
}

function buildMockConfig() {
  return {
    getOrThrow: vi.fn().mockReturnValue({
      passkey: {
        rpId: 'localhost',
        rpName: 'Astroid',
        origin: 'http://localhost:3001',
      },
    }),
  };
}

const VALID_INPUT = {
  expectedChallenge: 'test-challenge-abc123',
  credential: {
    id: 'cred-id-123',
    rawId: 'cred-id-123',
    response: {
      attestationObject: 'o2NmbXRkbmF2U0dGMIIB3Q',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoidGVzdC1jaGFsbGVuZ2UtYWJjMTIzIn0',
    },
    type: 'public-key' as const,
  },
  deviceName: 'YubiKey 5',
};

const STORED_CHALLENGE = JSON.stringify({
  userId: 'user-1',
  purpose: 'registration',
});

// ── Tests ──

describe('PasskeyService', () => {
  let prisma: ReturnType<typeof buildMockPrisma>;
  let redis: ReturnType<typeof buildMockRedis>;
  let config: ReturnType<typeof buildMockConfig>;
  let service: PasskeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = buildMockPrisma();
    redis = buildMockRedis();
    config = buildMockConfig();
    service = new PasskeyService(
      prisma as unknown as PrismaService,
      redis as unknown as Redis,
      config as unknown as ConfigService,
    );
  });

  describe('verifyRegistration', () => {
    it('should verify and persist a valid registration credential', async () => {
      // Setup mocks
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      redis.get.mockResolvedValue(STORED_CHALLENGE);

      // Mock successful verification
      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          fmt: 'none',
          aaguid: '00000000-0000-0000-0000-000000000000',
          credential: {
            id: 'cred-id-123',
            publicKey: new Uint8Array([165, 1, 2, 3, 38, 32, 1]),
            counter: 0,
          },
          credentialType: 'public-key',
          attestationObject: new Uint8Array([160]),
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:3001',
          rpID: 'localhost',
        },
      });

      prisma.passkeyCredential.create.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-id-123',
        publicKey: 'pQEDJg',
        counter: 0,
        deviceName: 'YubiKey 5',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(),
      });

      const result = await service.verifyRegistration('user-1', VALID_INPUT, 'Mozilla/5.0');

      // Verify the service called simplewebauthn correctly
      expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          response: VALID_INPUT.credential,
          expectedChallenge: 'test-challenge-abc123',
          expectedOrigin: 'http://localhost:3001',
          expectedRPID: 'localhost',
        }),
      );

      // Verify challenge was consumed (one-time use)
      expect(redis.del).toHaveBeenCalledWith('auth:passkey:challenge:test-challenge-abc123');

      // Verify credential was persisted
      expect(prisma.passkeyCredential.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          credentialId: 'cred-id-123',
          publicKey: expect.stringMatching(/.+/),
          counter: 0,
          deviceName: 'YubiKey 5',
          userAgent: 'Mozilla/5.0',
        },
      });

      // Verify return shape
      expect(result).toEqual({
        credentialId: 'cred-id-123',
        publicKey: expect.stringMatching(/.+/),
        counter: 0,
      });
    });

    it('should throw NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyRegistration('nonexistent-user', VALID_INPUT),
      ).rejects.toThrow('User');
    });

    it('should throw ValidationException when no active challenge exists', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      redis.get.mockResolvedValue(null);

      await expect(
        service.verifyRegistration('user-1', VALID_INPUT),
      ).rejects.toThrow('No active registration challenge');
    });

    it('should throw UnauthorizedException when the challenge belongs to another user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      redis.get.mockResolvedValue(
        JSON.stringify({ userId: 'user-2', purpose: 'registration' }),
      );

      await expect(
        service.verifyRegistration('user-1', VALID_INPUT),
      ).rejects.toThrow('verification failed');
    });

    it('should throw UnauthorizedException when verification fails', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      redis.get.mockResolvedValue(STORED_CHALLENGE);

      // Mock failed verification (wrong challenge, bad signature, etc.)
      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: false,
        registrationInfo: undefined,
      });

      await expect(
        service.verifyRegistration('user-1', VALID_INPUT),
      ).rejects.toThrow('verification failed');
    });

    it('should pass user agent to the credential record', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      redis.get.mockResolvedValue(STORED_CHALLENGE);

      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          fmt: 'none',
          aaguid: '00000000-0000-0000-0000-000000000000',
          credential: {
            id: 'cred-id-456',
            publicKey: new Uint8Array([165, 1, 2, 3]),
            counter: 1,
          },
          credentialType: 'public-key',
          attestationObject: new Uint8Array([160]),
          userVerified: false,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:3001',
        },
      });

      prisma.passkeyCredential.create.mockResolvedValue({
        id: 'pk-2',
        userId: 'user-1',
        credentialId: 'cred-id-456',
        publicKey: 'pQED',
        counter: 1,
        deviceName: null,
        userAgent: 'Chrome/120',
        createdAt: new Date(),
      });

      await service.verifyRegistration(
        'user-1',
        { ...VALID_INPUT, expectedChallenge: 'test-challenge-abc123', deviceName: undefined },
        'Chrome/120',
      );

      expect(prisma.passkeyCredential.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userAgent: 'Chrome/120',
          deviceName: null,
        }),
      });
    });
  });
});

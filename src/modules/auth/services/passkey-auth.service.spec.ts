import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PasskeyService } from './passkey.service';
import { PrismaService } from '../../../database/prisma.service';

// ── Mock @simplewebauthn/server ──
const mockGenerateRegistrationOptions = vi.fn();
const mockVerifyRegistrationResponse = vi.fn();
const mockGenerateAuthenticationOptions = vi.fn();
const mockVerifyAuthenticationResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...args: unknown[]) => mockGenerateRegistrationOptions(...args),
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistrationResponse(...args),
  generateAuthenticationOptions: (...args: unknown[]) => mockGenerateAuthenticationOptions(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthenticationResponse(...args),
}));

// ── Helpers ──

interface MockTx {
  passkeyChallenge: { deleteMany: Mock; create: Mock };
  passkeyCredential: { create: Mock; update: Mock; findMany: Mock; findUnique: Mock };
}

function buildMockPrisma() {
  const txMock: MockTx = {
    passkeyChallenge: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
    },
    passkeyCredential: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
  };

  return {
    user: { findUnique: vi.fn() },
    passkeyChallenge: {
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    passkeyCredential: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: MockTx) => Promise<MockTx>) => {
      return cb(txMock);
    }),
    _txMock: txMock,
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

// ── Tests ──

describe('PasskeyService - Authentication Flow', () => {
  let prisma: ReturnType<typeof buildMockPrisma>;
  let config: ReturnType<typeof buildMockConfig>;
  let service: PasskeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = buildMockPrisma();
    config = buildMockConfig();
    service = new PasskeyService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('generateRegistrationOptions', () => {
    it('should generate and store registration options', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      prisma.passkeyCredential.findMany.mockResolvedValue([]);

      mockGenerateRegistrationOptions.mockResolvedValue({
        challenge: 'reg-challenge-abc123',
        rp: { name: 'Astroid', id: 'localhost' },
        user: { id: 'user-1', name: 'test@example.com', displayName: 'Test User' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'preferred' },
      });

      const result = await service.generateRegistrationOptions('user-1');

      expect(result.challenge).toBe('reg-challenge-abc123');
      expect(result.rp.name).toBe('Astroid');
      expect(prisma.passkeyChallenge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          challenge: 'reg-challenge-abc123',
        }),
      });
    });

    it('should throw NotFoundException for unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.generateRegistrationOptions('unknown-user'),
      ).rejects.toThrow('User');
    });
  });

  describe('generateAuthenticationOptions', () => {
    it('should generate and store authentication options', async () => {
      prisma.passkeyCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1' },
        { credentialId: 'cred-2' },
      ]);

      mockGenerateAuthenticationOptions.mockResolvedValue({
        challenge: 'auth-challenge-xyz789',
        rpID: 'localhost',
        timeout: 60000,
        allowCredentials: [
          { id: 'cred-1', type: 'public-key', transports: ['internal'] },
          { id: 'cred-2', type: 'public-key', transports: ['internal'] },
        ],
        userVerification: 'preferred',
      });

      const result = await service.generateAuthenticationOptions('user-1');

      expect(result.challenge).toBe('auth-challenge-xyz789');
      expect(result.allowCredentials).toHaveLength(2);
      expect(prisma.passkeyChallenge.create).toHaveBeenCalled();
    });

    it('should throw NotFoundException when no credentials exist', async () => {
      prisma.passkeyCredential.findMany.mockResolvedValue([]);

      await expect(
        service.generateAuthenticationOptions('user-1'),
      ).rejects.toThrow('Passkey credentials');
    });
  });

  describe('verifyAuthentication', () => {
    it('should verify a valid authentication assertion', async () => {
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        userId: 'user-1',
        challenge: 'auth-challenge-xyz789',
        expiresAt: new Date(Date.now() + 300_000),
      });

      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-1',
        publicKey: 'pQEDJg',
        counter: 5,
      });

      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 6 },
      });

      const result = await service.verifyAuthentication({
        expectedChallenge: 'auth-challenge-xyz789',
        credential: {
          id: 'cred-1',
          rawId: 'cred-1',
          response: {
            authenticatorData: 'mock-auth-data',
            clientDataJSON: 'mock-client-data',
            signature: 'mock-signature',
          },
          type: 'public-key' as const,
        },
        credentialId: 'cred-1',
      });

      expect(result.verified).toBe(true);
      expect(result.userId).toBe('user-1');
      expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedChallenge: 'auth-challenge-xyz789',
          expectedOrigin: 'http://localhost:3001',
          expectedRPID: 'localhost',
        }),
      );
    });

    it('should throw ValidationException when no challenge exists', async () => {
      prisma.passkeyChallenge.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyAuthentication({
          expectedChallenge: 'expired-challenge',
          credential: {
            id: 'cred-1',
            rawId: 'cred-1',
            response: {
              authenticatorData: 'mock-auth-data',
              clientDataJSON: 'mock-client-data',
              signature: 'mock-signature',
            },
            type: 'public-key' as const,
          },
          credentialId: 'cred-1',
        }),
      ).rejects.toThrow('No active authentication challenge');
    });

    it('should throw NotFoundException when credential does not exist', async () => {
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        userId: 'user-1',
        challenge: 'auth-challenge-xyz789',
        expiresAt: new Date(Date.now() + 300_000),
      });

      prisma.passkeyCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyAuthentication({
          expectedChallenge: 'auth-challenge-xyz789',
          credential: {
            id: 'nonexistent-cred',
            rawId: 'nonexistent-cred',
            response: {
              authenticatorData: 'mock-auth-data',
              clientDataJSON: 'mock-client-data',
              signature: 'mock-signature',
            },
            type: 'public-key' as const,
          },
          credentialId: 'nonexistent-cred',
        }),
      ).rejects.toThrow('Passkey credential');
    });

    it('should throw UnauthorizedException when verification fails', async () => {
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        userId: 'user-1',
        challenge: 'auth-challenge-xyz789',
        expiresAt: new Date(Date.now() + 300_000),
      });

      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-1',
        publicKey: 'pQEDJg',
        counter: 5,
      });

      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: false,
        authenticationInfo: { newCounter: 5 },
      });

      await expect(
        service.verifyAuthentication({
          expectedChallenge: 'auth-challenge-xyz789',
          credential: {
            id: 'cred-1',
            rawId: 'cred-1',
            response: {
              authenticatorData: 'mock-auth-data',
              clientDataJSON: 'mock-client-data',
              signature: 'bad-signature',
            },
            type: 'public-key' as const,
          },
          credentialId: 'cred-1',
        }),
      ).rejects.toThrow('verification failed');
    });
  });

  describe('revokeCredential', () => {
    it('should delete a credential belonging to the user', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-1',
      });
      prisma.passkeyCredential.delete = vi.fn().mockResolvedValue({});

      await service.revokeCredential('user-1', 'cred-1');

      expect(prisma.passkeyCredential.delete).toHaveBeenCalledWith({
        where: { credentialId: 'cred-1' },
      });
    });

    it('should throw NotFoundException for non-existent credential', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeCredential('user-1', 'nonexistent'),
      ).rejects.toThrow('Passkey credential');
    });
  });
});

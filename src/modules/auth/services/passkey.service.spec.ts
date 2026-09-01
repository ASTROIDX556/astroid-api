import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { PasskeyService } from './passkey.service';
import { PrismaService } from '../../../database/prisma.service';

// ── Mock @simplewebauthn/server ──
const mockVerifyRegistrationResponse = vi.fn();
const mockVerifyAuthenticationResponse = vi.fn();
const mockGenerateRegistrationOptions = vi.fn();
const mockGenerateAuthenticationOptions = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistrationResponse(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthenticationResponse(...args),
  generateRegistrationOptions: (...args: unknown[]) => mockGenerateRegistrationOptions(...args),
  generateAuthenticationOptions: (...args: unknown[]) => mockGenerateAuthenticationOptions(...args),
}));

// ── Helpers ──

function buildMockPrisma() {
  return {
    user: {
      findUnique: vi.fn(),
    },
    passkeyChallenge: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    passkeyCredential: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return arg(txMock);
      }
      return arg;
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

const VALID_ASSERTION_INPUT = {
  expectedChallenge: 'test-auth-challenge',
  credential: {
    id: 'cred-id-123',
    rawId: 'cred-id-123',
    response: {
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidGVzdC1hdXRoLWNoYWxsZW5nZSJ9',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAQ',
      signature: 'waOhFpl0JrePswNyVrZ8DPsJFCn8UiLCvf0Eo2-sXHDAbG8z8Xp0gQpPfjHwQixQdGqDg1qQfQ7G_SkqjKp_Zw',
    },
    type: 'public-key' as const,
  },
};

const REGISTRATION_OPTIONS = {
  rp: { name: 'Astroid', id: 'localhost' },
  user: { id: 'user-1', name: 'test@example.com', displayName: 'Test User' },
  challenge: 'base64url-challenge-from-server',
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
  timeout: 60000,
  excludeCredentials: [],
  authenticatorSelection: {
    residentKey: 'preferred',
    userVerification: 'preferred',
  },
};

const AUTHENTICATION_OPTIONS = {
  challenge: 'base64url-auth-challenge',
  timeout: 60000,
  rpId: 'localhost',
  allowCredentials: [{ id: 'cred-id-123', type: 'public-key' }],
  userVerification: 'preferred',
};

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

  // ── generateRegistrationOptions ──

  describe('generateRegistrationOptions', () => {
    it('should return registration options and store the challenge', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      prisma.passkeyCredential.findMany.mockResolvedValue([]);
      mockGenerateRegistrationOptions.mockResolvedValue(REGISTRATION_OPTIONS);

      const result = await service.generateRegistrationOptions('user-1');

      expect(result).toEqual(REGISTRATION_OPTIONS);
      expect(prisma.passkeyCredential.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { credentialId: true },
      });
      expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          rpName: 'Astroid',
          rpID: 'localhost',
          userName: 'test@example.com',
          userDisplayName: 'Test User',
          attestationType: 'none',
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.passkeyChallenge.deleteMany).toHaveBeenCalled();
      expect(prisma.passkeyChallenge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          challenge: 'base64url-challenge-from-server',
        }),
      });
    });

    it('should include existing credentials in excludeCredentials', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      prisma.passkeyCredential.findMany.mockResolvedValue([
        { credentialId: 'existing-cred-1' },
        { credentialId: 'existing-cred-2' },
      ]);
      mockGenerateRegistrationOptions.mockResolvedValue(REGISTRATION_OPTIONS);

      await service.generateRegistrationOptions('user-1');

      expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          excludeCredentials: [{ id: 'existing-cred-1' }, { id: 'existing-cred-2' }],
        }),
      );
    });

    it('should throw NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.generateRegistrationOptions('nonexistent'),
      ).rejects.toThrow('User');
    });
  });

  // ── verifyRegistration ──

  describe('verifyRegistration', () => {
    it('should verify and persist a valid registration credential', async () => {
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

      expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          response: VALID_INPUT.credential,
          expectedChallenge: 'test-challenge-abc123',
          expectedOrigin: 'http://localhost:3001',
          expectedRPID: 'localhost',
        }),
      );

      expect(prisma._txMock.passkeyChallenge.deleteMany).toHaveBeenCalled();
      expect(prisma._txMock.passkeyCredential.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          credentialId: 'cred-id-123',
          publicKey: expect.stringMatching(/.+/),
          counter: 0,
          deviceName: 'YubiKey 5',
          userAgent: 'Mozilla/5.0',
        },
      });

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

  // ── generateAuthenticationOptions ──

  describe('generateAuthenticationOptions', () => {
    it('should return authentication options and store the challenge', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      prisma.passkeyCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-id-123' },
      ]);
      mockGenerateAuthenticationOptions.mockResolvedValue(AUTHENTICATION_OPTIONS);

      const result = await service.generateAuthenticationOptions('test@example.com');

      expect(result).toEqual(AUTHENTICATION_OPTIONS);
      expect(mockGenerateAuthenticationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          rpID: 'localhost',
          allowCredentials: [{ id: 'cred-id-123' }],
          userVerification: 'preferred',
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.passkeyChallenge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          challenge: 'base64url-auth-challenge',
        }),
      });
    });

    it('should lower-case the email when looking up the user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'Test@Example.com',
      });
      prisma.passkeyCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-id-123' },
      ]);
      mockGenerateAuthenticationOptions.mockResolvedValue(AUTHENTICATION_OPTIONS);

      await service.generateAuthenticationOptions('Test@Example.com');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
    });

    it('should throw NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.generateAuthenticationOptions('nobody@example.com'),
      ).rejects.toThrow('User');
    });

    it('should throw ValidationException when user has no passkeys', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      prisma.passkeyCredential.findMany.mockResolvedValue([]);

      await expect(
        service.generateAuthenticationOptions('test@example.com'),
      ).rejects.toThrow('No passkeys registered');
    });
  });

  // ── verifyAuthentication ──

  describe('verifyAuthentication', () => {
    it('should verify a valid assertion and update the counter', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-id-123',
        publicKey: Buffer.from([165, 1, 2, 3, 38, 32, 1]).toString('base64url'),
        counter: 0,
        deviceName: 'YubiKey 5',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(),
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-auth-1',
        userId: 'user-1',
        challenge: 'test-auth-challenge',
        expiresAt: new Date(Date.now() + 300_000),
      });

      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: 'cred-id-123',
          newCounter: 1,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:3001',
          rpID: 'localhost',
        },
      });

      const result = await service.verifyAuthentication(VALID_ASSERTION_INPUT);

      expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          response: VALID_ASSERTION_INPUT.credential,
          expectedChallenge: 'test-auth-challenge',
          expectedOrigin: 'http://localhost:3001',
          expectedRPID: 'localhost',
          credential: expect.objectContaining({
            id: 'cred-id-123',
            counter: 0,
          }),
        }),
      );

      expect(prisma.passkeyChallenge.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(prisma.passkeyCredential.update).toHaveBeenCalledWith({
        where: { id: 'pk-1' },
        data: expect.objectContaining({
          counter: 1,
        }),
      });

      expect(result).toEqual({
        credentialId: 'cred-id-123',
        userId: 'user-1',
        newCounter: 1,
      });
    });

    it('should throw NotFoundException when credential is not registered', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyAuthentication(VALID_ASSERTION_INPUT),
      ).rejects.toThrow('Passkey credential');
    });

    it('should throw ValidationException when no active challenge exists', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-id-123',
        publicKey: 'pQEDJg',
        counter: 0,
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyAuthentication(VALID_ASSERTION_INPUT),
      ).rejects.toThrow('No active authentication challenge');
    });

    it('should throw UnauthorizedException when verification fails', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-id-123',
        publicKey: 'pQEDJg',
        counter: 0,
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-auth-1',
        userId: 'user-1',
        challenge: 'test-auth-challenge',
        expiresAt: new Date(Date.now() + 300_000),
      });

      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: false,
        authenticationInfo: undefined,
      });

      await expect(
        service.verifyAuthentication(VALID_ASSERTION_INPUT),
      ).rejects.toThrow('authentication verification failed');
    });

    it('should update user agent alongside counter', async () => {
      prisma.passkeyCredential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-id-123',
        publicKey: 'pQEDJg',
        counter: 0,
        userAgent: 'old-agent',
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-auth-1',
        userId: 'user-1',
        challenge: 'test-auth-challenge',
        expiresAt: new Date(Date.now() + 300_000),
      });

      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: 'cred-id-123',
          newCounter: 2,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:3001',
          rpID: 'localhost',
        },
      });

      await service.verifyAuthentication(VALID_ASSERTION_INPUT, 'Chrome/120');

      expect(prisma.passkeyCredential.update).toHaveBeenCalledWith({
        where: { id: 'pk-1' },
        data: expect.objectContaining({
          userAgent: 'Chrome/120',
        }),
      });
    });
  });

  // ── listCredentials ──

  describe('listCredentials', () => {
    it('should return credentials for the user', async () => {
      prisma.passkeyCredential.findMany.mockResolvedValue([
        {
          id: 'pk-1',
          credentialId: 'cred-1',
          deviceName: 'YubiKey',
          userAgent: 'Chrome',
          createdAt: new Date(),
        },
      ]);

      const result = await service.listCredentials('user-1');

      expect(prisma.passkeyCredential.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: {
          id: true,
          credentialId: true,
          deviceName: true,
          userAgent: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  // ── removeCredential ──

  describe('removeCredential', () => {
    it('should delete a credential owned by the user', async () => {
      prisma.passkeyCredential.findFirst.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-1',
      });

      await service.removeCredential('user-1', 'pk-1');

      expect(prisma.passkeyCredential.findFirst).toHaveBeenCalledWith({
        where: { id: 'pk-1', userId: 'user-1' },
      });
      expect(prisma.passkeyCredential.delete).toHaveBeenCalledWith({
        where: { id: 'pk-1' },
      });
    });

    it('should throw NotFoundException when credential is not owned by the user', async () => {
      prisma.passkeyCredential.findFirst.mockResolvedValue(null);

      await expect(
        service.removeCredential('user-1', 'pk-1'),
      ).rejects.toThrow('Passkey credential');
    });
  });
});

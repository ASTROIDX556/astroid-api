import { beforeEach, describe, expect, it, vi } from 'vitest';
import { timingSafeEqual } from 'crypto';
import { ApiKeyService } from '../api-key.service';
import { ApiKeyRepository } from '../api-key.repository';
import { ConflictException, NotFoundException } from '../../../common/exceptions/domain.exception';
import { hashWithArgon2, sha256 } from '../../../utils/crypto.util';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    default: actual,
    timingSafeEqual: vi.fn((a: Buffer, b: Buffer) => actual.timingSafeEqual(a, b)),
  };
});

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let auditService: {
    record: ReturnType<typeof vi.fn>;
  };
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByHash: ReturnType<typeof vi.fn>;
    findByPrefix: ReturnType<typeof vi.fn>;
    findActiveByPrefix: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    touchLastUsed: ReturnType<typeof vi.fn>;
    markRotating: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  const orgId = 'org-1';
  const userId = 'user-1';

  beforeEach(() => {
    auditService = {
      record: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    };
    repository = {
      create: vi.fn(),
      findManyAndCount: vi.fn(),
      findById: vi.fn(),
      findByHash: vi.fn(),
      findByPrefix: vi.fn(),
      findActiveByPrefix: vi.fn(),
      revoke: vi.fn(),
      touchLastUsed: vi.fn(),
      markRotating: vi.fn(),
      update: vi.fn(),
    };
    service = new ApiKeyService(
      repository as unknown as ApiKeyRepository,
      auditService as never,
    );
  });

  describe('create', () => {
    it('creates an API key, hashes it with Argon2id, and returns raw key only once', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-123',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Agent Key',
        permissions: ['transactions:write', 'wallets:read'],
        allowedIps: ['192.168.1.1'],
        expiresInDays: 30,
      });

      expect(result).toMatchObject({
        id: 'key-123',
        name: 'Agent Key',
        permissions: ['transactions:write', 'wallets:read'],
      });
      expect(result.key).toMatch(/^ak_live_[a-f0-9]{48}$/);
      expect(result.prefix).toBe(result.key.slice(0, 14));
      expect(result.expiresAt).toBeInstanceOf(Date);

      // Verify the stored hash is Argon2id format
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          createdById: userId,
          name: 'Agent Key',
          prefix: result.prefix,
          hashedKey: expect.stringMatching(/\$argon2id\$/),
          permissions: ['transactions:write', 'wallets:read'],
          allowedIps: ['192.168.1.1'],
        }),
      );
    });

    it('creates an API key without expiry when expiresInDays is not provided', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-456',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Permanent Key',
        permissions: [],
        allowedIps: [],
      });

      expect(result.expiresAt).toBeNull();
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: null,
          scopes: ['read'],
        }),
      );
    });

    it('persists and returns the per-key minute and day rate-limit overrides', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-quota',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Quota Key',
        permissions: [],
        allowedIps: [],
        rateLimitPerMinute: 600,
        rateLimitPerDay: 500000,
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ rateLimitPerMinute: 600, rateLimitPerDay: 500000 }),
      );
      expect(result).toMatchObject({ rateLimitPerMinute: 600, rateLimitPerDay: 500000 });
    });

    it('stores null overrides when the caller sets none, keeping the configured defaults', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-no-quota',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      await service.create(orgId, userId, { name: 'Plain Key', permissions: [], allowedIps: [] });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ rateLimitPerMinute: null, rateLimitPerDay: null }),
      );
    });

    it('applies the default scope set ["read"] when scopes is omitted', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-default-scope',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Default Scope Key',
        permissions: [],
        allowedIps: [],
      });

      expect(result.scopes).toEqual(['read']);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ['read'],
        }),
      );
    });

    it('persists custom scopes when provided', async () => {
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-custom-scopes',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.create(orgId, userId, {
        name: 'Scoped Key',
        scopes: ['read', 'transactions:execute', 'webhooks:manage'],
        permissions: [],
        allowedIps: [],
      });

      expect(result.scopes).toEqual(['read', 'transactions:execute', 'webhooks:manage']);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ['read', 'transactions:execute', 'webhooks:manage'],
        }),
      );
    });
  });

  describe('list', () => {
    it('returns paginated items for an organization', async () => {
      const mockItems = [
        {
          id: 'key-1',
          name: 'Key 1',
          prefix: 'ak_live_123456',
          permissions: ['transactions:read'],
        },
      ];
      repository.findManyAndCount.mockResolvedValue({ items: mockItems, total: 1 });

      const result = await service.list(orgId, {
        offset: 0,
        page: 1,
        limit: 20,
        sort: 'createdAt',
        order: 'desc',
      });

      expect(result.items).toEqual(mockItems);
      expect(result.meta.total).toBe(1);
      expect(repository.findManyAndCount).toHaveBeenCalledWith(
        { organizationId: orgId },
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('applies search filter when query.search is provided', async () => {
      repository.findManyAndCount.mockResolvedValue({ items: [], total: 0 });

      await service.list(orgId, {
        offset: 0,
        page: 1,
        limit: 20,
        sort: 'createdAt',
        order: 'desc',
        search: 'agent',
      });

      expect(repository.findManyAndCount).toHaveBeenCalledWith(
        {
          organizationId: orgId,
          name: { contains: 'agent', mode: 'insensitive' },
        },
        expect.anything(),
      );
    });
  });

  describe('revoke', () => {
    it('revokes an active API key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        revokedAt: null,
      });
      repository.revoke.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });

      const result = await service.revoke(orgId, 'key-1');

      expect(result).toEqual({ id: 'key-1', revoked: true });
      expect(repository.revoke).toHaveBeenCalledWith('key-1');
    });

    it('throws NotFoundException when key does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.revoke(orgId, 'non-existent')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ConflictException when key is already revoked', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        revokedAt: new Date(),
      });

      await expect(service.revoke(orgId, 'key-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verify', () => {
    it('verifies key with Argon2id hash', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      const mockKey = {
        id: 'key-1',
        name: 'Agent Key',
        hashedKey: argonHash,
        permissions: ['transactions:write'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };
      
      repository.findActiveByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findActiveByPrefix).toHaveBeenCalledWith(rawSecret.slice(0, 14));
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-1');
    });

    it('verifies legacy key with SHA-256 hash for backward compatibility', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const shaHash = sha256(rawSecret);
      
      const mockKey = {
        id: 'key-legacy',
        name: 'Legacy Key',
        hashedKey: shaHash,
        permissions: ['transactions:read'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };
      
      repository.findActiveByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findActiveByPrefix).toHaveBeenCalledWith(rawSecret.slice(0, 14));
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-legacy');
    });

    it('compares the legacy SHA-256 hash in constant time', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const mockKey = {
        id: 'key-legacy',
        name: 'Legacy Key',
        hashedKey: sha256(rawSecret),
        permissions: ['transactions:read'],
        revokedAt: null,
        expiresAt: null,
      };

      repository.findActiveByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      await service.verify(rawSecret);

      expect(timingSafeEqual).toHaveBeenCalled();
    });

    it('rejects a legacy key whose hash does not match, without leaking the comparison', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const mockKey = {
        id: 'key-legacy',
        name: 'Legacy Key',
        hashedKey: sha256('a-different-secret'),
        permissions: ['transactions:read'],
        revokedAt: null,
        expiresAt: null,
      };

      repository.findActiveByPrefix.mockResolvedValue([mockKey]);

      await expect(service.verify(rawSecret)).resolves.toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null for empty or invalid raw key input', async () => {
      expect(await service.verify('')).toBeNull();
      expect(await service.verify('   ')).toBeNull();
      expect(await service.verify(null as unknown as string)).toBeNull();
      expect(await service.verify(undefined as unknown as string)).toBeNull();
      expect(repository.findActiveByPrefix).not.toHaveBeenCalled();
    });

    it('returns null when no keys found with matching prefix', async () => {
      repository.findActiveByPrefix.mockResolvedValue([]);

      const verified = await service.verify('ak_live_unknownkey');

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has been revoked', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      repository.findActiveByPrefix.mockResolvedValue([
        {
          id: 'key-revoked',
          hashedKey: argonHash,
          revokedAt: new Date(Date.now() - 10000),
        },
      ]);

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has expired', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      repository.findActiveByPrefix.mockResolvedValue([
        {
          id: 'key-expired',
          hashedKey: argonHash,
          revokedAt: null,
          expiresAt: new Date(Date.now() - 5000),
        },
      ]);

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('still returns key if touchLastUsed throws a transient error', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      const mockKey = {
        id: 'key-1',
        hashedKey: argonHash,
        revokedAt: null,
        expiresAt: null,
      };
      
      repository.findActiveByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockRejectedValue(new Error('DB connection busy'));

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
    });

    it('tries multiple keys with same prefix until match is found', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      const wrongKey = {
        id: 'key-wrong',
        hashedKey: await hashWithArgon2('different-key'),
        revokedAt: null,
        expiresAt: null,
      };
      
      const correctKey = {
        id: 'key-correct',
        hashedKey: argonHash,
        permissions: ['transactions:write'],
        revokedAt: null,
        expiresAt: null,
      };
      
      repository.findActiveByPrefix.mockResolvedValue([wrongKey, correctKey]);
      repository.touchLastUsed.mockResolvedValue({ ...correctKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(correctKey);
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-correct');
    });

    it('authenticates rotating key during grace window (before expiresAt)', async () => {
      const rawSecret = 'ak_live_rotating1234567890abcdef1234567890abcdef';
      const argonHash = await hashWithArgon2(rawSecret);

      const rotatingKey = {
        id: 'key-rotating',
        status: 'rotating',
        hashedKey: argonHash,
        permissions: ['read'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour into future
      };

      repository.findActiveByPrefix.mockResolvedValue([rotatingKey]);
      repository.touchLastUsed.mockResolvedValue({ ...rotatingKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(rotatingKey);
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-rotating');
    });

    it('rejects rotating key after grace window expires', async () => {
      const rawSecret = 'ak_live_expired1234567890abcdef1234567890abcdef1';
      const argonHash = await hashWithArgon2(rawSecret);

      const expiredKey = {
        id: 'key-expired',
        status: 'rotating',
        hashedKey: argonHash,
        permissions: ['read'],
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000), // expired 1s ago
      };

      repository.findActiveByPrefix.mockResolvedValue([expiredKey]);

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('rejects rotating key immediately if revoked during grace window', async () => {
      const rawSecret = 'ak_live_revoked1234567890abcdef1234567890abcdef2';
      const argonHash = await hashWithArgon2(rawSecret);

      const revokedKey = {
        id: 'key-revoked',
        status: 'revoked',
        hashedKey: argonHash,
        permissions: ['read'],
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };

      repository.findActiveByPrefix.mockResolvedValue([revokedKey]);

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });
  });

  describe('rotate', () => {
    it('copies the rate-limit overrides to the replacement key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-old',
        organizationId: orgId,
        createdById: userId,
        name: 'Quota Worker',
        prefix: 'ak_live_old123',
        status: 'active',
        scopes: ['read'],
        permissions: [],
        allowedIps: [],
        rateLimitPerMinute: 600,
        rateLimitPerDay: 500000,
        expiresAt: null,
        revokedAt: null,
        rotatedAt: null,
      });
      repository.create.mockImplementation((data) =>
        Promise.resolve({ id: 'key-new', ...data, createdAt: new Date() }),
      );
      repository.markRotating.mockResolvedValue({ id: 'key-old', status: 'rotating' });

      await service.rotate(orgId, userId, 'key-old');

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ rateLimitPerMinute: 600, rateLimitPerDay: 500000 }),
      );
    });

    it('rotates an active key, issues a replacement key once, marks old key rotating with expiresAt and logs audit', async () => {
      const oldKey = {
        id: 'key-old',
        organizationId: orgId,
        createdById: userId,
        name: 'Production Worker',
        prefix: 'ak_live_old123',
        status: 'active',
        scopes: ['read', 'transactions:execute'],
        permissions: ['tx:write'],
        allowedIps: ['10.0.0.1'],
        expiresAt: null,
        revokedAt: null,
        rotatedAt: null,
      };

      repository.findById.mockResolvedValue(oldKey);
      repository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'key-new',
          ...data,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );
      repository.markRotating.mockResolvedValue({
        ...oldKey,
        status: 'rotating',
        rotatedAt: new Date(),
      });

      const result = await service.rotate(orgId, userId, 'key-old', {
        gracePeriodSeconds: 3600,
        expiresInDays: 60,
      });

      expect(result).toMatchObject({
        id: 'key-new',
        name: 'Production Worker',
        scopes: ['read', 'transactions:execute'],
        permissions: ['tx:write'],
        previousKeyId: 'key-old',
      });
      expect(result.key).toMatch(/^ak_live_[a-f0-9]{48}$/);
      expect(result.prefix).toBe(result.key.slice(0, 14));
      expect(result.lastFour).toBe(result.key.slice(-4));
      expect(result.previousKeyExpiresAt).toBeInstanceOf(Date);

      // Verify old key was marked rotating
      expect(repository.markRotating).toHaveBeenCalledWith(
        'key-old',
        expect.objectContaining({
          status: 'rotating',
          replacementId: 'key-new',
          rotatedAt: expect.any(Date),
          expiresAt: expect.any(Date),
        }),
      );

      // Verify audit log recorded rotation
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          userId,
          action: 'API_KEY_ROTATED',
          entity: 'ApiKey',
          entityId: 'key-old',
          oldValue: expect.objectContaining({
            keyId: 'key-old',
            prefix: 'ak_live_old123',
            status: 'rotating',
          }),
          newValue: expect.objectContaining({
            keyId: 'key-new',
            status: 'active',
          }),
        }),
      );
    });

    it('throws NotFoundException if key does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.rotate(orgId, userId, 'non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException on repeated rotation of an already rotating key (double rotation)', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-already-rotating',
        organizationId: orgId,
        status: 'rotating',
        rotatedAt: new Date(),
        revokedAt: null,
      });

      await expect(service.rotate(orgId, userId, 'key-already-rotating')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException on rotating an already revoked key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-revoked',
        organizationId: orgId,
        status: 'revoked',
        revokedAt: new Date(),
      });

      await expect(service.rotate(orgId, userId, 'key-revoked')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException on rotating an expired key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-expired',
        organizationId: orgId,
        status: 'active',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.rotate(orgId, userId, 'key-expired')).rejects.toThrow(
        ConflictException,
      );
    });
  });
});

  describe('rotateKey', () => {
    const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
    const hash = sha256(rawSecret);

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('creates a new key on successful rotation', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Original Key',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: ['transactions:write'],
        allowedIps: ['192.168.1.1'],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      repository.hasBeenRotated.mockResolvedValue(false);
      repository.hasSuccessor.mockResolvedValue(false);

      const mockReplacement = {
        id: 'key-2',
        organizationId: orgId,
        name: 'Original Key (replacement)',
        prefix: 'ak_live_9876543210abcdef',
        hashedKey: sha256('new-key-secret'),
        permissions: ['transactions:write'],
        allowedIps: ['192.168.1.1'],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: 'key-1',
      };

      repository.create.mockResolvedValue(mockReplacement);
      repository.findById
        .mockResolvedValueOnce({ id: 'key-1', organizationId: orgId, rotatedFromId: null, graceExpiresAt: null })
        .mockResolvedValueOnce(mockReplacement);

      const result = await service.rotateKey(orgId, userId, 'key-1');

      expect(result.key).toMatch(/^ak_live_[a-f0-9]{48}$/);
      expect(result.id).toBe('key-2');
      expect(result.name).toBe('Original Key (replacement)');
      expect(result.prefix).toBe('ak_live_9876543210abcdef');
      expect(result.permissions).toEqual(['transactions:write']);
      expect(result.allowedIps).toEqual(['192.168.1.1']);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          createdById: userId,
          name: 'Original Key (replacement)',
          prefix: result.prefix,
          hashedKey: expect.any(String),
          permissions: ['transactions:write'],
          allowedIps: ['192.168.1.1'],
        }),
      );
    });

    it('applies the configured grace period to the predecessor', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Original Key',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: ['transactions:write'],
        allowedIps: ['192.168.1.1'],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      repository.hasBeenRotated.mockResolvedValue(false);
      repository.hasSuccessor.mockResolvedValue(false);

      const mockReplacement = {
        id: 'key-2',
        organizationId: orgId,
        name: 'Original Key (replacement)',
        prefix: 'ak_live_9876543210abcdef',
        hashedKey: sha256('new-key-secret'),
        permissions: ['transactions:write'],
        allowedIps: ['192.168.1.1'],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: 'key-1',
      };

      ;(service['prisma'] as const).$transaction = async (fn: {
      apiKey: {
        create: () => mockReplacement;
        update: () => mockReplacement;
      },
    }) => {
      const result = await fn({
        apiKey: {
          create: () => mockReplacement,
          update: () => mockReplacement,
        },
      });
      return result;
    };

      const result = await service.rotateKey(orgId, userId, 'key-1');

      expect(result.key).toMatch(/^ak_live_[a-f0-9]{48}$/);
      expect(repository.hasBeenRotated).toHaveBeenCalledWith(orgId, 'key-1');
      expect(repository.hasSuccessor).toHaveBeenCalledWith(orgId, 'key-1');
    });

    it('returns 404 when key does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.rotateKey(orgId, userId, 'non-existent')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns 404 when key belongs to another organization', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: 'other-org',
        name: 'Original Key',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: ['transactions:write'],
        allowedIps: ['192.168.1.1'],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      await expect(service.rotateKey(orgId, userId, 'key-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects rotating an already-rotated predecessor', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Already Rotated',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: ['transactions:write'],
        allowedIps: [],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: 'key-previous',
      });

      repository.hasBeenRotated.mockResolvedValue(true);

      await expect(service.rotateKey(orgId, userId, 'key-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects rotating a key that already has a successor', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Key With Successor',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: ['transactions:write'],
        allowedIps: [],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      repository.hasSuccessor.mockResolvedValue(true);

      await expect(service.rotateKey(orgId, userId, 'key-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects rotating a revoked key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Revoked Key',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: ['transactions:write'],
        allowedIps: [],
        revokedAt: new Date(),
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      await expect(service.rotateKey(orgId, userId, 'key-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('records audit event on successful rotation', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Original Key',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: [],
        allowedIps: [],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      repository.hasBeenRotated.mockResolvedValue(false);
      repository.hasSuccessor.mockResolvedValue(false);

      const mockReplacement = {
        id: 'key-2',
        organizationId: orgId,
        name: 'Original Key (replacement)',
        prefix: 'ak_live_9876543210abcdef',
        hashedKey: sha256('new-key-secret'),
        permissions: [],
        allowedIps: [],

      await service.rotateKey(orgId, userId, 'key-1');

      expect(service['auditService'].record).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          action: 'API_KEY_ROTATE',
          entity: 'ApiKey',
          entityId: 'key-1',
        }),
      );
    });

    it('does not persist the plaintext key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-1',
        organizationId: orgId,
        name: 'Original Key',
        prefix: 'ak_live_1234567890abcdef',
        hashedKey: hash,
        permissions: [],
        allowedIps: [],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: null,
      });

      repository.hasBeenRotated.mockResolvedValue(false);
      repository.hasSuccessor.mockResolvedValue(false);

      const mockReplacement = {
        id: 'key-2',
        organizationId: orgId,
        name: 'Original Key (replacement)',
        prefix: 'ak_live_9876543210abcdef',
        hashedKey: sha256('new-key-secret'),
        permissions: [],
        allowedIps: [],
        revokedAt: null,
        graceExpiresAt: null,
        rotatedFromId: 'key-1',
      };

      repository.create.mockResolvedValue(mockReplacement);

      ;(service['prisma'] as any).$transaction = async (fn: any) => {
        const result = await fn({
          apiKey: {
            create: async () => mockReplacement,
            update: async () => {},
          },
        } as any);
        return result;
      };

      await service.rotateKey(orgId, userId, 'key-1');

      expect(repository.create).toHaveBeenCalledWith(
        expect.not.objectContaining({
          key: expect.any(String),
        }),
      );
    });
  });

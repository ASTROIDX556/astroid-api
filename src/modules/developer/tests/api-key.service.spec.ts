import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyService } from '../api-key.service';
import { ApiKeyRepository } from '../api-key.repository';
import { ConflictException, NotFoundException } from '../../../common/exceptions/domain.exception';
import { sha256 } from '../../../utils/crypto.util';

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByHash: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    touchLastUsed: ReturnType<typeof vi.fn>;
  };

  const orgId = 'org-1';
  const userId = 'user-1';

  beforeEach(() => {
    repository = {
      create: vi.fn(),
      findManyAndCount: vi.fn(),
      findById: vi.fn(),
      findByHash: vi.fn(),
      revoke: vi.fn(),
      touchLastUsed: vi.fn(),
    };
    service = new ApiKeyService(repository as unknown as ApiKeyRepository);
  });

  describe('create', () => {
    it('creates an API key, hashes it with SHA-256, and returns raw key only once', async () => {
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

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          createdById: userId,
          name: 'Agent Key',
          prefix: result.prefix,
          hashedKey: sha256(result.key),
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
    const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
    const hash = sha256(rawSecret);

    it('returns key and touches lastUsedAt when key is valid', async () => {
      const mockKey = {
        id: 'key-1',
        name: 'Agent Key',
        hashedKey: hash,
        permissions: ['transactions:write'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };
      repository.findByHash.mockResolvedValue(mockKey);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findByHash).toHaveBeenCalledWith(hash);
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-1');
    });

    it('returns null for empty or invalid raw key input', async () => {
      expect(await service.verify('')).toBeNull();
      expect(await service.verify('   ')).toBeNull();
      expect(await service.verify(null as unknown as string)).toBeNull();
      expect(await service.verify(undefined as unknown as string)).toBeNull();
      expect(repository.findByHash).not.toHaveBeenCalled();
    });

    it('returns null when key hash is not found in database', async () => {
      repository.findByHash.mockResolvedValue(null);

      const verified = await service.verify('ak_live_unknownkey');

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has been revoked', async () => {
      repository.findByHash.mockResolvedValue({
        id: 'key-revoked',
        hashedKey: hash,
        revokedAt: new Date(Date.now() - 10000),
      });

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has expired', async () => {
      repository.findByHash.mockResolvedValue({
        id: 'key-expired',
        hashedKey: hash,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 5000),
      });

      const verified = await service.verify(rawSecret);

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('still returns key if touchLastUsed throws a transient error', async () => {
      const mockKey = {
        id: 'key-1',
        hashedKey: hash,
        revokedAt: null,
        expiresAt: null,
      };
      repository.findByHash.mockResolvedValue(mockKey);
      repository.touchLastUsed.mockRejectedValue(new Error('DB connection busy'));

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
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

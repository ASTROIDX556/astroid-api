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
    findAuthenticatableByPrefix: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    touchLastUsed: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
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
      findAuthenticatableByPrefix: vi.fn(),
      revoke: vi.fn(),
      touchLastUsed: vi.fn(),
      rotate: vi.fn(),
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
      
      repository.findAuthenticatableByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findAuthenticatableByPrefix).toHaveBeenCalledWith(rawSecret.slice(0, 14));
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
      
      repository.findAuthenticatableByPrefix.mockResolvedValue([mockKey]);
      repository.touchLastUsed.mockResolvedValue({ ...mockKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(mockKey);
      expect(repository.findAuthenticatableByPrefix).toHaveBeenCalledWith(rawSecret.slice(0, 14));
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

      repository.findAuthenticatableByPrefix.mockResolvedValue([mockKey]);
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

      repository.findAuthenticatableByPrefix.mockResolvedValue([mockKey]);

      await expect(service.verify(rawSecret)).resolves.toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null for empty or invalid raw key input', async () => {
      expect(await service.verify('')).toBeNull();
      expect(await service.verify('   ')).toBeNull();
      expect(await service.verify(null as unknown as string)).toBeNull();
      expect(await service.verify(undefined as unknown as string)).toBeNull();
      expect(repository.findAuthenticatableByPrefix).not.toHaveBeenCalled();
    });

    it('returns null when no keys found with matching prefix', async () => {
      repository.findAuthenticatableByPrefix.mockResolvedValue([]);

      const verified = await service.verify('ak_live_unknownkey');

      expect(verified).toBeNull();
      expect(repository.touchLastUsed).not.toHaveBeenCalled();
    });

    it('returns null when key has been revoked', async () => {
      const rawSecret = 'ak_live_abcdef1234567890abcdef1234567890abcdef12';
      const argonHash = await hashWithArgon2(rawSecret);
      
      repository.findAuthenticatableByPrefix.mockResolvedValue([
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
      
      repository.findAuthenticatableByPrefix.mockResolvedValue([
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
      
      repository.findAuthenticatableByPrefix.mockResolvedValue([mockKey]);
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
      
      repository.findAuthenticatableByPrefix.mockResolvedValue([wrongKey, correctKey]);
      repository.touchLastUsed.mockResolvedValue({ ...correctKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(correctKey);
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-correct');
    });

    it('authenticates a rotating key only until previousKeyExpiresAt', async () => {
      const rawSecret = 'ak_live_rotating1234567890abcdef1234567890abcdef';
      const argonHash = await hashWithArgon2(rawSecret);

      const rotatingKey = {
        id: 'key-rotating',
        status: 'rotating',
        hashedKey: argonHash,
        permissions: ['read'],
        revokedAt: null,
        expiresAt: null,
        previousKeyExpiresAt: new Date(Date.now() + 3600 * 1000),
      };

      repository.findAuthenticatableByPrefix.mockResolvedValue([rotatingKey]);
      repository.touchLastUsed.mockResolvedValue({ ...rotatingKey, lastUsedAt: new Date() });

      const verified = await service.verify(rawSecret);

      expect(verified).toEqual(rotatingKey);
      expect(repository.touchLastUsed).toHaveBeenCalledWith('key-rotating');
    });

    it('authenticates both keys returned by rotation during the grace period', async () => {
      const oldRawKey = 'ak_live_previous1234567890abcdef1234567890abcdef';
      const oldKey = {
        id: 'key-old',
        organizationId: orgId,
        createdById: userId,
        name: 'Worker',
        prefix: oldRawKey.slice(0, 14),
        status: 'active',
        scopes: ['read'],
        permissions: [],
        allowedIps: [],
        expiresAt: null,
        revokedAt: null,
        rotatedAt: null,
      };
      repository.findById.mockResolvedValue(oldKey);
      let rotatingPrevious: Record<string, unknown> = {};
      let replacementKey: Record<string, unknown> = {};
      repository.rotate.mockImplementation(
        async (_organizationId, _id, _actorId, replacement, rotatedAt, previousKeyExpiresAt) => {
          rotatingPrevious = {
            ...oldKey,
            status: 'rotating',
            rotatedAt,
            previousKeyExpiresAt,
            hashedKey: await hashWithArgon2(oldRawKey),
          };
          replacementKey = {
            id: 'key-new',
            ...replacement,
          };
          return { previous: rotatingPrevious, replacement: replacementKey };
        },
      );

      const rotated = await service.rotate(orgId, userId, 'key-old', {
        gracePeriodSeconds: 3600,
      });
      repository.findAuthenticatableByPrefix.mockImplementation((prefix) =>
        Promise.resolve(prefix === oldKey.prefix ? [rotatingPrevious] : [replacementKey]),
      );

      await expect(service.verify(oldRawKey)).resolves.toMatchObject({ id: 'key-old' });
      await expect(service.verify(rotated.key)).resolves.toMatchObject({ id: 'key-new' });
    });

    it('authenticates only the replacement after the grace deadline', async () => {
      const oldRawKey = 'ak_live_previous9876543210abcdef1234567890abcdef';
      const newRawKey = 'ak_live_replacement9876543210abcdef1234567890abcdef';
      const oldKey = {
        id: 'key-old',
        status: 'rotating',
        hashedKey: await hashWithArgon2(oldRawKey),
        revokedAt: null,
        expiresAt: null,
        previousKeyExpiresAt: new Date('2026-01-01T01:00:00.000Z'),
      };
      const newKey = {
        id: 'key-new',
        status: 'active',
        hashedKey: await hashWithArgon2(newRawKey),
        revokedAt: null,
        expiresAt: null,
        previousKeyExpiresAt: null,
      };

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:59:59.000Z'));
        repository.findAuthenticatableByPrefix.mockImplementation((prefix) =>
          Promise.resolve(prefix === oldRawKey.slice(0, 14) ? [oldKey] : [newKey]),
        );
        await expect(service.verify(oldRawKey)).resolves.toMatchObject({ id: 'key-old' });
        await expect(service.verify(newRawKey)).resolves.toMatchObject({ id: 'key-new' });

        vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
        await expect(service.verify(oldRawKey)).resolves.toBeNull();
        await expect(service.verify(newRawKey)).resolves.toMatchObject({ id: 'key-new' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a rotating key after previousKeyExpiresAt, even if a stale lookup returns it', async () => {
      const rawSecret = 'ak_live_expired1234567890abcdef1234567890abcdef1';
      const argonHash = await hashWithArgon2(rawSecret);

      const expiredKey = {
        id: 'key-expired',
        status: 'rotating',
        hashedKey: argonHash,
        permissions: ['read'],
        revokedAt: null,
        expiresAt: null,
        previousKeyExpiresAt: new Date(Date.now() - 1000),
      };

      repository.findAuthenticatableByPrefix.mockResolvedValue([expiredKey]);

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

      repository.findAuthenticatableByPrefix.mockResolvedValue([revokedKey]);

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
      repository.rotate.mockResolvedValue({
        previous: { id: 'key-old', status: 'rotating' },
        replacement: { id: 'key-new' },
      });

      await service.rotate(orgId, userId, 'key-old');

      expect(repository.rotate).toHaveBeenCalledWith(
        orgId,
        'key-old',
        userId,
        expect.objectContaining({ rateLimitPerMinute: 600, rateLimitPerDay: 500000 }),
        expect.any(Date),
        expect.any(Date),
      );
    });

    it('rotates an active key, stores only the replacement hash, and returns it once', async () => {
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
      repository.rotate.mockImplementation(
        async (_organizationId, _id, _actorId, replacement) => ({
          previous: {
            ...oldKey,
            status: 'rotating',
            rotatedAt: new Date(),
            previousKeyExpiresAt: new Date(),
          },
          replacement: {
            id: 'key-new',
            ...replacement,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
          },
        }),
      );

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

      expect(repository.rotate).toHaveBeenCalledWith(
        orgId,
        'key-old',
        userId,
        expect.objectContaining({
          organizationId: orgId,
          createdById: userId,
          hashedKey: expect.stringMatching(/\$argon2id\$/),
          expiresAt: expect.any(Date),
        }),
        expect.any(Date),
        expect.any(Date),
      );
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('returns 404 when another actor attempts to rotate the key', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-owned-by-another-actor',
        organizationId: orgId,
        createdById: 'different-user',
        status: 'active',
        revokedAt: null,
        rotatedAt: null,
        expiresAt: null,
      });

      await expect(service.rotate(orgId, userId, 'key-owned-by-another-actor')).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.rotate).not.toHaveBeenCalled();
    });

    it('uses the configured default grace period and preserves the original expiry', async () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      try {
        const keyExpiry = new Date('2026-01-10T00:00:00.000Z');
        repository.findById.mockResolvedValue({
          id: 'key-old',
          organizationId: orgId,
          createdById: userId,
          name: 'Expiring Worker',
          prefix: 'ak_live_old123',
          status: 'active',
          scopes: ['read'],
          permissions: [],
          allowedIps: [],
          expiresAt: keyExpiry,
          revokedAt: null,
          rotatedAt: null,
        });
        repository.rotate.mockImplementation(
          async (_organizationId, _id, _actorId, replacement) => ({
            previous: { id: 'key-old', status: 'rotating' },
            replacement: { id: 'key-new', ...replacement },
          }),
        );
        const configuredService = new ApiKeyService(
          repository as unknown as ApiKeyRepository,
          auditService as never,
          { apiKeyRotationGracePeriodSeconds: 3600 } as never,
        );

        const result = await configuredService.rotate(orgId, userId, 'key-old');

        expect(repository.rotate).toHaveBeenCalledWith(
          orgId,
          'key-old',
          userId,
          expect.objectContaining({ expiresAt: keyExpiry }),
          now,
          new Date('2026-01-01T01:00:00.000Z'),
        );
        expect(result.expiresAt).toEqual(keyExpiry);
      } finally {
        vi.useRealTimers();
      }
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
        createdById: userId,
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
        createdById: userId,
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
        createdById: userId,
        organizationId: orgId,
        status: 'active',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.rotate(orgId, userId, 'key-expired')).rejects.toThrow(
        ConflictException,
      );
    });

    it('does not return a replacement if another rotation wins the atomic claim', async () => {
      repository.findById.mockResolvedValue({
        id: 'key-raced',
        organizationId: orgId,
        createdById: userId,
        status: 'active',
        revokedAt: null,
        rotatedAt: null,
        expiresAt: null,
      });
      repository.rotate.mockResolvedValue(null);

      await expect(service.rotate(orgId, userId, 'key-raced')).rejects.toThrow(
        ConflictException,
      );
    });

    it('does not revive a previous key when rotating its replacement', async () => {
      const expiredPreviousRawKey = 'ak_live_expired1234567890abcdef1234567890abcdef';
      const expiredPreviousKey = {
        id: 'key-previous',
        status: 'rotating',
        hashedKey: await hashWithArgon2(expiredPreviousRawKey),
        revokedAt: null,
        expiresAt: null,
        previousKeyExpiresAt: new Date(Date.now() - 1000),
      };
      repository.findAuthenticatableByPrefix.mockResolvedValue([expiredPreviousKey]);
      await expect(service.verify(expiredPreviousRawKey)).resolves.toBeNull();

      repository.findById.mockResolvedValue({
        id: 'key-current',
        organizationId: orgId,
        createdById: userId,
        name: 'Worker',
        prefix: 'ak_live_current',
        status: 'active',
        scopes: ['read'],
        permissions: [],
        allowedIps: [],
        expiresAt: null,
        revokedAt: null,
        rotatedAt: null,
      });
      repository.rotate.mockResolvedValue({
        previous: { id: 'key-current', status: 'rotating' },
        replacement: { id: 'key-next', expiresAt: null },
      });

      await service.rotate(orgId, userId, 'key-current');

      await expect(service.verify(expiredPreviousRawKey)).resolves.toBeNull();
    });
  });
});

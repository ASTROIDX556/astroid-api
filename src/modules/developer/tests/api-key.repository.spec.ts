import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyRepository } from '../api-key.repository';
import { PrismaService } from '../../../database/prisma.service';

describe('ApiKeyRepository', () => {
  let repository: ApiKeyRepository;
  let transaction: {
    apiKey: {
      updateMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    apiKey: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    transaction = {
      apiKey: {
        updateMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
      apiKey: { findMany: vi.fn() },
    };
    repository = new ApiKeyRepository(prisma as unknown as PrismaService);
  });

  it('filters candidates to active keys and unrevoked rotating keys within grace', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    prisma.apiKey.findMany.mockResolvedValue([]);

    await repository.findAuthenticatableByPrefix('ak_live_prefix', now);

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: {
        prefix: 'ak_live_prefix',
        revokedAt: null,
        OR: [
          { status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            status: 'rotating',
            previousKeyExpiresAt: { gt: now },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        ],
      },
    });
  });

  it('does not create a replacement if the conditional rotation claim loses a race', async () => {
    transaction.apiKey.updateMany.mockResolvedValue({ count: 0 });

    const result = await repository.rotate(
      'org-1',
      'key-1',
      'user-1',
      { organizationId: 'org-1', name: 'replacement' } as never,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(result).toBeNull();
    expect(transaction.apiKey.create).not.toHaveBeenCalled();
    expect(transaction.apiKey.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'key-1',
        organizationId: 'org-1',
        createdById: 'user-1',
        status: 'active',
        revokedAt: null,
        rotatedAt: null,
      }),
      data: expect.objectContaining({ status: 'rotating' }),
    });
  });

  it('creates the replacement and links it in the same transaction', async () => {
    const replacement = { id: 'key-new' };
    const previous = { id: 'key-old', replacementId: 'key-new' };
    transaction.apiKey.updateMany.mockResolvedValue({ count: 1 });
    transaction.apiKey.create.mockResolvedValue(replacement);
    transaction.apiKey.update.mockResolvedValue(previous);

    await expect(
      repository.rotate(
        'org-1',
        'key-old',
        'user-1',
        { organizationId: 'org-1', name: 'replacement' } as never,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-02T00:00:00.000Z'),
      ),
    ).resolves.toEqual({ previous, replacement });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(transaction.apiKey.create).toHaveBeenCalledOnce();
    expect(transaction.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'key-old' },
      data: { replacementId: 'key-new' },
    });
  });
});

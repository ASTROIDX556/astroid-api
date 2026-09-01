import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OrganizationService } from './organization.service';
import { OrganizationRepository } from './organization.repository';
import { EventBusService } from '../../events/event-bus.service';
import { PrismaService } from '../../database/prisma.service';
import { DomainEventName } from '../../events/event-names';
import { sha256 } from '../../utils/crypto.util';

describe('OrganizationService.rotateKeys', () => {
  let service: OrganizationService;
  let repository: OrganizationRepository;
  let eventBus: EventBusService;

  beforeEach(() => {
    repository = {
      findById: vi.fn().mockResolvedValue({ id: 'org-1', deletedAt: null }),
      findActiveApiKeys: vi.fn().mockResolvedValue([]),
      createApiKey: vi.fn().mockImplementation((data) =>
        Promise.resolve({ id: 'key-new', ...data, createdAt: new Date(), revokedAt: null }),
      ),
      revokeApiKey: vi.fn().mockImplementation((id) =>
        Promise.resolve({ id, revokedAt: new Date() }),
      ),
    } as unknown as OrganizationRepository;

    eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventBusService;

    service = new OrganizationService(
      repository,
      eventBus,
      {} as unknown as PrismaService,
    );
  });

  const adminKey = (id: string, permissions: string[] = ['admin']) => ({
    id,
    organizationId: 'org-1',
    createdById: 'user-1',
    name: 'Admin API key',
    prefix: 'ak_live_abcd',
    hashedKey: 'hashed',
    permissions,
    allowedIps: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
  });

  it('revokes every active admin key and mints a fresh one', async () => {
    vi.mocked(repository.findActiveApiKeys).mockResolvedValue([
      adminKey('key-1'),
      adminKey('key-2'),
    ]);

    const result = await service.rotateKeys('org-1', 'user-1', {});

    expect(repository.revokeApiKey).toHaveBeenCalledWith('key-1');
    expect(repository.revokeApiKey).toHaveBeenCalledWith('key-2');
    expect(repository.createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        createdById: 'user-1',
        permissions: ['admin'],
      }),
    );
    // The raw secret is returned exactly once, its hash is what gets stored.
    expect(result.key).toMatch(/^ak_live_/);
    const created = vi.mocked(repository.createApiKey).mock.calls[0][0];
    expect(created.hashedKey).toBe(sha256(result.key));
    expect(result.revokedCount).toBe(2);
  });

  it('emits an OrganizationKeyRotated domain event with audit context', async () => {
    vi.mocked(repository.findActiveApiKeys).mockResolvedValue([adminKey('key-1')]);

    await service.rotateKeys('org-1', 'user-1', { reason: 'possible leak' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.OrganizationKeyRotated,
      expect.objectContaining({
        keyId: 'key-new',
        revokedCount: 1,
        reason: 'possible leak',
      }),
      expect.objectContaining({
        organizationId: 'org-1',
        actorId: 'user-1',
        aggregateType: 'organization',
        aggregateId: 'org-1',
      }),
    );
  });

  it('mints a key when the organization has no admin key yet', async () => {
    vi.mocked(repository.findActiveApiKeys).mockResolvedValue([
      adminKey('key-1', ['transactions:read']),
    ]);

    const result = await service.rotateKeys('org-1', 'user-1', {});

    // Non-admin keys are never touched.
    expect(repository.revokeApiKey).not.toHaveBeenCalled();
    expect(repository.createApiKey).toHaveBeenCalledTimes(1);
    expect(result.revokedCount).toBe(0);
  });

  it('uses the provided name for the new key', async () => {
    await service.rotateKeys('org-1', 'user-1', { name: 'CI admin key' });

    expect(repository.createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CI admin key' }),
    );
  });

  it('throws when the organization does not exist', async () => {
    vi.mocked(repository.findById).mockResolvedValue(null);

    await expect(service.rotateKeys('org-missing', 'user-1', {})).rejects.toThrow(
      "Organization 'org-missing' not found",
    );
    expect(repository.createApiKey).not.toHaveBeenCalled();
  });
});

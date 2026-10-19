import { describe, expect, it, vi } from 'vitest';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';
import { WebhookDestinationError } from './webhook-destination.policy';

function record(id: string, secret: string) {
  return {
    id,
    organizationId: 'org-1',
    url: `https://example.com/${id}`,
    secret,
    events: ['wallet.created'],
    enabled: true,
    createdAt: new Date('2026-09-29T00:00:00.000Z'),
    updatedAt: new Date('2026-09-29T00:00:00.000Z'),
  };
}

describe('WebhookService signing-secret lifecycle', () => {
  it('returns a cryptographically random secret only from creation', async () => {
    const create = vi.fn(async (data: { organizationId: string; url: string; secret: string; events: string[]; enabled: boolean }) =>
      record('wh-1', data.secret),
    );
    const destinationPolicy = { validate: vi.fn().mockResolvedValue({}) };
    const service = new WebhookService(
      { create } as unknown as WebhookRepository,
      destinationPolicy as never,
    );

    const created = await service.create('org-1', {
      url: 'https://example.com/hook',
      events: ['wallet.created'],
      enabled: true,
    });

    expect(created.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    expect(created).not.toHaveProperty('signingSecret');
    expect(destinationPolicy.validate).toHaveBeenCalledWith('https://example.com/hook');
  });

  it('rotates only the requested endpoint and redacts secrets from later reads', async () => {
    const current = record('wh-1', 'old-secret');
    const findById = vi.fn(async (organizationId: string, id: string) =>
      organizationId === 'org-1' && id === current.id ? current : null,
    );
    const update = vi.fn(async (id: string, changes: { secret?: string }) => ({
      ...current,
      id,
      secret: changes.secret ?? current.secret,
    }));
    const service = new WebhookService(
      { findById, update } as unknown as WebhookRepository,
      { validate: vi.fn().mockResolvedValue({}) } as never,
    );

    const rotated = await service.rotateSecret('org-1', 'wh-1');
    const nextSecret = rotated.secret;
    expect(nextSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(nextSecret).not.toBe('old-secret');
    expect(update).toHaveBeenCalledWith('wh-1', { secret: nextSecret });
    expect(update).toHaveBeenCalledTimes(1);

    const fetched = await service.get('org-1', 'wh-1');
    expect(fetched).not.toHaveProperty('secret');
  });

  it('rejects blocked destinations on create and update with a safe validation error', async () => {
    const repository = {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(record('wh-1', 'secret')),
      update: vi.fn(),
    } as unknown as WebhookRepository;
    const destinationPolicy = {
      validate: vi.fn().mockRejectedValue(new WebhookDestinationError('Webhook destination must be a public IP address')),
    };
    const service = new WebhookService(repository, destinationPolicy as never);

    await expect(
      service.create('org-1', { url: 'https://127.0.0.1/hook', events: ['wallet.created'], enabled: true }),
    ).rejects.toThrow('Webhook destination must be a public IP address');
    await expect(service.update('org-1', 'wh-1', { url: 'https://127.0.0.1/hook' })).rejects.toThrow(
      'Webhook destination must be a public IP address',
    );
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });
});
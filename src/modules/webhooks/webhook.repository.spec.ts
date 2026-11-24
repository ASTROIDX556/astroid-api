import { describe, expect, it, vi } from 'vitest';
import { WebhookRepository } from './webhook.repository';
import { PrismaService } from '../../database/prisma.service';

describe('WebhookRepository signing-secret redaction', () => {
  it('never selects the secret on endpoint read paths', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const $transaction = vi.fn(async (batch: Promise<unknown>[]) => Promise.all(batch));
    const prisma = { webhook: { findMany, count }, $transaction } as unknown as PrismaService;
    const repository = new WebhookRepository(prisma);

    await repository.findManyAndCount({}, { skip: 0, take: 10, orderBy: { createdAt: 'desc' } });

    expect(findMany.mock.calls[0][0].select).not.toHaveProperty('secret');
    expect(findMany.mock.calls[0][0].select).toMatchObject({
      id: true,
      organizationId: true,
      url: true,
      events: true,
      enabled: true,
    });
  });
});

describe('WebhookRepository.findDeliveryPage', () => {
  it('asks for limit + 1 rows, scoped to the organization, with a keyset cursor', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn();
    const prisma = { webhookDelivery: { findMany, count } } as unknown as PrismaService;
    const repository = new WebhookRepository(prisma);
    const createdAt = new Date('2026-09-29T12:00:00.000Z');

    await repository.findDeliveryPage('org-1', { createdAt, id: 'delivery-20' }, 21);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { organizationId: 'org-1' },
          {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: 'delivery-20' } },
            ],
          },
        ],
      },
      take: 21,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    // No count query: the extra row is what tells us another page exists.
    expect(count).not.toHaveBeenCalled();
  });

  it('queries the first page scoped to the organization without a cursor condition', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { webhookDelivery: { findMany } } as unknown as PrismaService;
    const repository = new WebhookRepository(prisma);

    await repository.findDeliveryPage('org-2', undefined, 11);

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-2' },
      take: 11,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
});

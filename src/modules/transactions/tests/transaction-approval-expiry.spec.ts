import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, RiskBand, Transaction } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { TransactionService } from '../transaction.service';
import { ApprovalExpiryQueue } from '../../../queues/approval-expiry.queue';

const NOW = new Date('2026-11-23T10:00:00.000Z');

function buildService(ttlHours: number | undefined) {
  const prisma = {
    proposal: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'prop-1', ...data })),
    },
  };
  const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn((key: string) => (key === 'approval.ttlHours' ? ttlHours : undefined)) };
  const approvalExpiry = { schedule: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() };
  const service = new TransactionService(
    ...([
      {}, {}, {}, {}, {}, {}, {},
      eventBus,
      prisma,
      {},
      undefined,
      undefined,
      config as unknown as ConfigService,
      undefined,
      approvalExpiry as unknown as ApprovalExpiryQueue,
    ] as unknown as ConstructorParameters<typeof TransactionService>),
  );
  return { service, prisma, approvalExpiry };
}

const tx = {
  id: 'tx-1',
  amount: new Prisma.Decimal(25),
  asset: 'XLM',
  purpose: null,
} as unknown as Transaction;

describe('TransactionService approval expiry scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets expiresAt from the configured TTL and schedules the delayed expiry job', async () => {
    const { service, prisma, approvalExpiry } = buildService(2);

    await service['createProposal']('org-1', tx, RiskBand.LOW);

    const expiresAt = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(prisma.proposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'PENDING', expiresAt }),
    });
    expect(approvalExpiry.schedule).toHaveBeenCalledWith({
      proposalId: 'prop-1',
      organizationId: 'org-1',
      expiresAt,
    });
  });

  it('honours a per-policy TTL override', async () => {
    const { service, approvalExpiry } = buildService(72);

    await service['createProposal']('org-1', tx, RiskBand.LOW, 1);

    expect(approvalExpiry.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: new Date(NOW.getTime() + 3_600_000) }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDecision, ProposalStatus } from '@prisma/client';
import { DecideProposalInput } from './approval.dto';
import { ConfigService } from '@nestjs/config';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalIdempotencyRepository } from './approval-idempotency.repository';
import { TransactionService } from '../transactions/transaction.service';
import { EventBusService } from '../../events/event-bus.service';
import { DomainException } from '../../common/exceptions/domain.exception';

describe('ApprovalService idempotency', () => {
  let service: ApprovalService;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let transactions: { execute: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  let idempotency: Record<string, ReturnType<typeof vi.fn>>;
  let settings: { keyTtlMs: number; waitTimeoutMs: number; pollIntervalMs: number };

  const proposal = {
    id: 'proposal-1',
    organizationId: 'org-1',
    status: ProposalStatus.PENDING,
    requiredApprovals: 1,
    transactionId: 'transaction-1',
    expiresAt: new Date(Date.now() + 60_000),
  };

  beforeEach(() => {
    settings = { keyTtlMs: 86_400_000, waitTimeoutMs: 100, pollIntervalMs: 5 };

    repository = {
      findById: vi.fn().mockResolvedValue(proposal),
      findApprovalByUser: vi.fn().mockResolvedValue(null),
      createApproval: vi.fn().mockResolvedValue({ id: 'approval-1' }),
      countApprovals: vi.fn().mockResolvedValue(1),
      updateProposalStatus: vi.fn().mockResolvedValue(proposal),
    };
    transactions = {
      execute: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    // In-memory stand-in for the Prisma-backed store, including expiry.
    const records = new Map<string, Record<string, unknown>>();
    idempotency = {
      reserve: vi.fn().mockImplementation((input: Record<string, unknown>) => {
        const recordKey = `${input.principalId}:${input.operation}:${input.keyHash}`;
        const existing = records.get(recordKey);
        if (existing && (existing.expiresAt as Date).getTime() <= Date.now()) {
          records.delete(recordKey);
        }
        const current = records.get(recordKey);
        if (current) return Promise.resolve({ record: current, created: false });

        const record = {
          id: `idempotency-${records.size + 1}`,
          ...input,
          status: 'PROCESSING',
          response: null,
        };
        records.set(recordKey, record);
        return Promise.resolve({ record, created: true });
      }),
      complete: vi.fn().mockImplementation((id: string, response: unknown, expiresAt: Date) => {
        const record = [...records.values()].find((item) => item.id === id);
        if (record) Object.assign(record, { response, expiresAt, status: 'COMPLETED' });
        return Promise.resolve(record);
      }),
      release: vi.fn().mockImplementation((id: string) => {
        for (const [recordKey, record] of records) {
          if (record.id === id) records.delete(recordKey);
        }
        return Promise.resolve({ count: 1 });
      }),
    };

    service = new ApprovalService(
      repository as unknown as ApprovalRepository,
      transactions as unknown as TransactionService,
      { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventBusService,
      idempotency as unknown as ApprovalIdempotencyRepository,
      { get: vi.fn(() => settings) } as unknown as ConfigService,
    );
  });

  const decide = (
    key: string,
    principalId = 'user-1',
    decision: DecideProposalInput['decision'] = ApprovalDecision.APPROVED,
  ) =>
    service.decide(
      'org-1',
      principalId,
      'proposal-1',
      { decision },
      { principalId, key },
    );

  it('records the decision once and persists the response for replay', async () => {
    const result = await decide('decision-key-1');

    expect(result).toMatchObject({ id: 'proposal-1' });
    expect(repository.createApproval).toHaveBeenCalledTimes(1);
    expect(transactions.execute).toHaveBeenCalledTimes(1);
    expect(idempotency.complete).toHaveBeenCalledTimes(1);
  });

  it('replays the stored response without recording a second decision', async () => {
    const first = await decide('decision-key-2');
    const replay = await decide('decision-key-2');

    expect(replay).toEqual(JSON.parse(JSON.stringify(first)) as unknown);
    expect(repository.createApproval).toHaveBeenCalledTimes(1);
    expect(transactions.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a key with a different payload as a 422', async () => {
    await decide('decision-key-3');

    const error = await decide('decision-key-3', 'user-1', ApprovalDecision.REJECTED).catch(
      (reason: unknown) => reason as DomainException,
    );

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getStatus()).toBe(422);
    expect(repository.createApproval).toHaveBeenCalledTimes(1);
  });

  it('treats an expired record as a new request', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await decide('decision-key-expired');

      // One millisecond past the configured retention window.
      vi.setSystemTime(new Date(Date.now() + settings.keyTtlMs + 1));
      await decide('decision-key-expired');
    } finally {
      vi.useRealTimers();
    }

    expect(repository.createApproval).toHaveBeenCalledTimes(2);
    expect(transactions.execute).toHaveBeenCalledTimes(2);
  });

  it('scopes the same key independently to each authenticated identity', async () => {
    await decide('shared-key', 'user-1');
    await decide('shared-key', 'user-2');

    expect(repository.createApproval).toHaveBeenCalledTimes(2);
    expect(transactions.execute).toHaveBeenCalledTimes(2);
  });
});

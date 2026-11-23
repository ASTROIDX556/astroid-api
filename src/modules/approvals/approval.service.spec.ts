import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDecision, Proposal, ProposalStatus } from '@prisma/client';
import { DecideProposalInput } from './approval.dto';
import { ConfigService } from '@nestjs/config';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalIdempotencyRepository } from './approval-idempotency.repository';
import { TransactionService } from '../transactions/transaction.service';
import { EventBusService } from '../../events/event-bus.service';
import { DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';

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
      transitionStatus: vi.fn().mockResolvedValue(true),
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
      undefined,
      undefined,
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

  it('rejects reuse of a key with a different payload as a 422 mismatch', async () => {
    await decide('decision-key-3');

    const error = await decide('decision-key-3', 'user-1', ApprovalDecision.REJECTED).catch(
      (reason: unknown) => reason as DomainException,
    );

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getStatus()).toBe(422);
    expect(error).toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_MISMATCH });
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

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    organizationId: 'org-1',
    transactionId: 'transaction-1',
    title: 'Payment approval',
    description: null,
    approvalType: 'DUAL',
    requiredApprovals: 2,
    status: ProposalStatus.PENDING,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ApprovalService lifecycle guards', () => {
  it('allows only one of two concurrent threshold approvals to execute', async () => {
    let status: ProposalStatus = ProposalStatus.PENDING;
    const current = proposal();
    const repository = {
      findById: vi.fn(async () => ({ ...current, status })),
      findApprovalByUser: vi.fn().mockResolvedValue(null),
      createApproval: vi.fn().mockResolvedValue({ id: 'approval-1' }),
      countApprovals: vi.fn().mockResolvedValue(2),
      transitionStatus: vi.fn(async (_id: string, from: ProposalStatus, to: ProposalStatus) => {
        if (status !== from) return false;
        status = to;
        return true;
      }),
    };
    const transactions = { execute: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() };
    const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    const service = new ApprovalService(repository as never, transactions as never, eventBus as never);

    const outcomes = await Promise.allSettled([
      service.decide('org-1', 'reviewer-1', 'proposal-1', { decision: ApprovalDecision.APPROVED }),
      service.decide('org-1', 'reviewer-2', 'proposal-1', { decision: ApprovalDecision.APPROVED }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: ErrorCode.INVALID_PROPOSAL_TRANSITION, status: 409 } });
    expect(transactions.execute).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
  });

  it('expires a stale proposal at action time without recording an approval', async () => {
    const stale = proposal({ expiresAt: new Date(Date.now() - 1_000) });
    const repository = {
      findById: vi.fn().mockResolvedValue(stale),
      transitionStatus: vi.fn().mockResolvedValue(true),
      findApprovalByUser: vi.fn(),
      createApproval: vi.fn(),
      countApprovals: vi.fn(),
    };
    const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    const service = new ApprovalService(repository as never, { execute: vi.fn(), cancel: vi.fn() } as never, eventBus as never);

    await expect(
      service.decide('org-1', 'reviewer-1', stale.id, { decision: ApprovalDecision.APPROVED }),
    ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_EXPIRED, status: 409 });
    expect(repository.createApproval).not.toHaveBeenCalled();
    expect(repository.transitionStatus).toHaveBeenCalledWith(
      stale.id,
      ProposalStatus.PENDING,
      ProposalStatus.EXPIRED,
    );
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });

  it('does not mutate a terminal proposal', async () => {
    const rejected = proposal({ status: ProposalStatus.REJECTED });
    const repository = {
      findById: vi.fn().mockResolvedValue(rejected),
      transitionStatus: vi.fn(),
      findApprovalByUser: vi.fn(),
      createApproval: vi.fn(),
      countApprovals: vi.fn(),
    };
    const service = new ApprovalService(repository as never, { execute: vi.fn(), cancel: vi.fn() } as never, { emit: vi.fn() } as never);

    await expect(
      service.decide('org-1', 'reviewer-1', rejected.id, { decision: ApprovalDecision.APPROVED }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PROPOSAL_TRANSITION, status: 409 });
    expect(repository.transitionStatus).not.toHaveBeenCalled();
    expect(repository.createApproval).not.toHaveBeenCalled();
  });

  describe('sweepExpired and budget release', () => {
    it('sweeps expired pending proposals, releases held budget, and cancels transactions', async () => {
      const expiredProposal = {
        ...proposal({
          id: 'prop-expired-1',
          transactionId: 'tx-1',
          expiresAt: new Date(Date.now() - 5000),
        }),
        transaction: {
          id: 'tx-1',
          budgetId: 'budget-1',
          amount: { toString: () => '50.0000000' },
        },
      };

      const repository = {
        findExpiredPending: vi.fn().mockResolvedValue([expiredProposal]),
        transitionStatus: vi.fn().mockResolvedValue(true),
      };
      const transactions = { cancel: vi.fn().mockResolvedValue(undefined) };
      const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
      const budgets = { releaseBudget: vi.fn().mockResolvedValue(undefined) };

      const service = new ApprovalService(
        repository as never,
        transactions as never,
        eventBus as never,
        budgets as never,
      );

      const summary = await service.sweepExpired(10);

      expect(summary).toEqual({ scanned: 1, expired: 1 });
      expect(repository.transitionStatus).toHaveBeenCalledWith(
        'prop-expired-1',
        ProposalStatus.PENDING,
        ProposalStatus.EXPIRED,
      );
      expect(budgets.releaseBudget).toHaveBeenCalledWith('org-1', 'budget-1', 50);
      expect(transactions.cancel).toHaveBeenCalledWith('org-1', 'system:approval-sweep', 'tx-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'proposal.expired',
        { proposalId: 'prop-expired-1', transactionId: 'tx-1' },
        expect.objectContaining({ organizationId: 'org-1' }),
      );
    });

    it('releases held budget exactly once when sweep runs twice or overlaps concurrently', async () => {
      let isPending = true;
      const expiredProposal = {
        ...proposal({
          id: 'prop-concurrent-1',
          expiresAt: new Date(Date.now() - 5000),
        }),
        transaction: {
          id: 'tx-concurrent',
          budgetId: 'budget-abc',
          amount: { toString: () => '100.0000000' },
        },
      };

      const repository = {
        findExpiredPending: vi.fn().mockResolvedValue([expiredProposal]),
        transitionStatus: vi.fn(async (_id: string, from: ProposalStatus, _to: ProposalStatus) => {
          if (from === ProposalStatus.PENDING && isPending) {
            isPending = false;
            return true;
          }
          return false;
        }),
      };
      const transactions = { cancel: vi.fn().mockResolvedValue(undefined) };
      const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
      const budgets = { releaseBudget: vi.fn().mockResolvedValue(undefined) };

      const service = new ApprovalService(
        repository as never,
        transactions as never,
        eventBus as never,
        budgets as never,
      );

      // Run sweep twice (simulating overlapping workers or repeated job runs)
      const [result1, result2] = await Promise.all([
        service.sweepExpired(50),
        service.sweepExpired(50),
      ]);

      const totalExpired = result1.expired + result2.expired;
      expect(totalExpired).toBe(1); // exactly one worker won the transition
      expect(budgets.releaseBudget).toHaveBeenCalledTimes(1);
      expect(budgets.releaseBudget).toHaveBeenCalledWith('org-1', 'budget-abc', 100);
    });

    it('rejects decision on already expired proposal with PROPOSAL_EXPIRED error', async () => {
      const alreadyExpired = proposal({
        id: 'prop-already-expired',
        status: ProposalStatus.EXPIRED,
        expiresAt: new Date(Date.now() - 10000),
      });

      const repository = {
        findById: vi.fn().mockResolvedValue(alreadyExpired),
        transitionStatus: vi.fn(),
        createApproval: vi.fn(),
      };
      const service = new ApprovalService(
        repository as never,
        { execute: vi.fn(), cancel: vi.fn() } as never,
        { emit: vi.fn() } as never,
      );

      await expect(
        service.decide('org-1', 'user-1', alreadyExpired.id, { decision: ApprovalDecision.APPROVED }),
      ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_EXPIRED, status: 409 });

      await expect(
        service.decide('org-1', 'user-1', alreadyExpired.id, { decision: ApprovalDecision.REJECTED }),
      ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_EXPIRED, status: 409 });

      expect(repository.createApproval).not.toHaveBeenCalled();
    });
  });
});

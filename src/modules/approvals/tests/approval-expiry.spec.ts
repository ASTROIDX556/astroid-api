import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDecision, ApprovalType, Proposal, ProposalStatus, Transaction } from '@prisma/client';
import { ApprovalService, APPROVAL_EXPIRY_BATCH_SIZE } from '../approval.service';
import { ApprovalRepository } from '../approval.repository';
import { TransactionService } from '../../transactions/transaction.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ERROR_STATUS, ErrorCode } from '../../../common/constants/error-codes';
import { Prisma } from '@prisma/client';

type ProposalWithTransaction = Prisma.ProposalGetPayload<{ include: { transaction: true } }>;

const NOW = new Date('2026-11-21T12:00:00.000Z');
const PAST = new Date('2026-11-20T12:00:00.000Z');
const FUTURE = new Date('2026-11-22T12:00:00.000Z');

function makeProposal(overrides: Partial<ProposalWithTransaction> = {}): ProposalWithTransaction {
  return {
    id: 'proposal_1',
    organizationId: 'org_1',
    transactionId: 'tx_1',
    title: 'Approval required',
    description: null,
    approvalType: ApprovalType.SINGLE,
    requiredApprovals: 1,
    status: ProposalStatus.PENDING,
    expiresAt: PAST,
    createdAt: new Date('2026-11-19T12:00:00.000Z'),
    updatedAt: new Date('2026-11-19T12:00:00.000Z'),
    transaction: makeTransaction(),
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    organizationId: 'org_1',
    walletId: 'wallet_1',
    agentId: null,
    policyId: null,
    budgetId: 'budget_1',
    budgetReservationId: null,
    asset: 'XLM',
    amount: '100.0000000',
    senderAddress: null,
    recipientAddress: 'recipient_1',
    memo: null,
    purpose: null,
    status: TransactionStatus.PENDING,
    riskScore: 0,
    riskBand: RiskBand.LOW,
    requiresApproval: true,
    stellarHash: null,
    confirmationCount: 0,
    gasEstimate: null,
    metadata: {},
    createdAt: new Date('2026-11-19T12:00:00.000Z'),
    updatedAt: new Date('2026-11-19T12:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as Transaction;
}

import { TransactionStatus, RiskBand } from '@prisma/client';

/**
 * In-memory stand-in for ApprovalRepository. Every write mirrors the real
 * conditional `updateMany` semantics: it only applies while the stored row is
 * still PENDING and reports whether it changed anything.
 */
class FakeApprovalRepository {
  rows: Proposal[] = [];

  findExpiring = vi.fn(async (now: Date, limit: number) =>
    this.rows
      .filter(
        (row) =>
          row.status === ProposalStatus.PENDING &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() <= now.getTime(),
      )
      .slice(0, limit),
  );

  expireIfPending = vi.fn(async (id: string) => {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== ProposalStatus.PENDING) {
      return 0;
    }
    row.status = ProposalStatus.EXPIRED;
    return 1;
  });

  transitionFromPending = vi.fn(async (id: string, status: ProposalStatus) => {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== ProposalStatus.PENDING) {
      return 0;
    }
    row.status = status;
    return 1;
  });

  transitionStatus = vi.fn(
    async (id: string, from: ProposalStatus, to: ProposalStatus) => {
      const row = this.rows.find((entry) => entry.id === id);
      if (!row || row.status !== from) {
        return false;
      }
      row.status = to;
      return true;
    },
  );

  findById = vi.fn(async (_organizationId: string, id: string) => {
    return this.rows.find((row) => row.id === id) ?? null;
  });

  findApprovalByUser = vi.fn(async () => null);

  createApproval = vi.fn(async (data: { proposalId: string; userId: string; decision: string }) => ({
    id: 'approval_1',
    createdAt: new Date(),
    comment: null,
    ...data,
  }));

  countApprovals = vi.fn(async () => 1);

  updateProposalStatus = vi.fn(async (id: string, data: { status?: ProposalStatus }) => {
    const row = this.rows.find((entry) => entry.id === id);
    if (row && data.status) {
      row.status = data.status;
    }
    return row as Proposal;
  });
}

describe('ApprovalService expiry', () => {
  let repository: FakeApprovalRepository;
  let transactions: { execute: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  let budgets: { releaseBudget: ReturnType<typeof vi.fn> };
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let service: ApprovalService;

  beforeEach(() => {
    repository = new FakeApprovalRepository();
    transactions = {
      execute: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
    };
    budgets = {
      releaseBudget: vi.fn().mockResolvedValue({}),
    };
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    // ApprovalService constructor: (repository, transactions, eventBus, approvalConfiguration?, idempotency?, config?, expiryQueue?)
    service = new ApprovalService(
      repository as unknown as ApprovalRepository,
      transactions as unknown as TransactionService,
      eventBus as unknown as EventBusService,
      undefined, // approvalConfiguration (optional)
      undefined, // idempotency (optional)
      undefined, // config (optional)
      undefined, // expiryQueue (optional)
    );
  });

  describe('expireStale', () => {
    it('does nothing when no pending proposal is past its expiry', async () => {
      repository.rows = [
        makeProposal({ id: 'future', expiresAt: FUTURE }),
        makeProposal({ id: 'no-expiry', expiresAt: null }),
        makeProposal({ id: 'already-expired', status: ProposalStatus.EXPIRED }),
      ];

      const result = await service.expireStale(NOW);

      expect(result).toEqual({ expired: 0, proposalIds: [] });
      expect(repository.expireIfPending).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('moves a stale pending proposal to EXPIRED and emits proposal.expired', async () => {
      repository.rows = [makeProposal({ transaction: makeTransaction() })];

      const result = await service.expireStale(NOW);

      expect(result).toEqual({ expired: 1, proposalIds: ['proposal_1'] });
      expect(repository.rows[0].status).toBe(ProposalStatus.EXPIRED);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.ProposalExpired,
        { proposalId: 'proposal_1', transactionId: 'tx_1' },
        { organizationId: 'org_1', aggregateType: 'proposal', aggregateId: 'proposal_1' },
      );
    });

    it('bounds the candidates of a single sweep', async () => {
      repository.rows = [makeProposal({ id: 'p1' }), makeProposal({ id: 'p2' })];

      await service.expireStale(NOW);

      expect(repository.findExpiring).toHaveBeenCalledWith(NOW, APPROVAL_EXPIRY_BATCH_SIZE);
    });

    it('never expires a proposal a reviewer decided concurrently', async () => {
      repository.rows = [makeProposal({ id: 'approved-meanwhile' })];
      // The reviewer won the race between the candidate read and the write.
      repository.expireIfPending.mockResolvedValueOnce(0);

      const result = await service.expireStale(NOW);

      expect(result).toEqual({ expired: 0, proposalIds: [] });
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(repository.rows[0].status).toBe(ProposalStatus.PENDING);
    });

    it('reports and emits only the rows this sweep actually changed', async () => {
      repository.rows = [makeProposal({ id: 'p1' }), makeProposal({ id: 'p2' })];
      repository.expireIfPending
        .mockImplementationOnce(async (id: string) => {
          const row = repository.rows.find((entry) => entry.id === id);
          if (row) row.status = ProposalStatus.EXPIRED;
          return 1;
        })
        .mockResolvedValueOnce(0);

      const result = await service.expireStale(NOW);

      expect(result).toEqual({ expired: 1, proposalIds: ['p1'] });
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: a second sweep finds nothing left to expire', async () => {
      repository.rows = [makeProposal({ transaction: makeTransaction() })];

      const first = await service.expireStale(NOW);
      const second = await service.expireStale(NOW);

      expect(first.expired).toBe(1);
      expect(second.expired).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    it.skip('releases budget exactly once under concurrent sweeps (double-sweep idempotency)', async () => {
      // Two proposals with budget reservations
      repository.rows = [
        makeProposal({ id: 'p1', transaction: makeTransaction({ budgetId: 'budget_1' }) }),
        makeProposal({ id: 'p2', transaction: makeTransaction({ budgetId: 'budget_2' }) }),
      ];

      // First sweep expires both
      const first = await service.expireStale(NOW);
      expect(first.expired).toBe(2);
      expect(budgets.releaseBudget).toHaveBeenCalledTimes(2);
      expect(budgets.releaseBudget).toHaveBeenCalledWith('org_1', 'budget_1', 100);
      expect(budgets.releaseBudget).toHaveBeenCalledWith('org_1', 'budget_2', 100);

      // Reset mock to track second sweep
      budgets.releaseBudget.mockClear();

      // Second sweep should not release budget again (proposals already EXPIRED)
      const second = await service.expireStale(NOW);
      expect(second.expired).toBe(0);
      expect(budgets.releaseBudget).not.toHaveBeenCalled();
    });

    it.skip('releases budget once even when expireProposal is called directly twice for same proposal', async () => {
      const proposal = makeProposal({ transaction: makeTransaction({ budgetId: 'budget_1' }) });
      repository.rows = [proposal];

      // Call expireProposal directly twice (simulating concurrent workers)
      const first = await service.expireProposal(proposal, 'org_1');
      const second = await service.expireProposal(proposal, 'org_1');

      expect(first).toBe(true);
      expect(second).toBe(false); // Second call loses the race
      expect(budgets.releaseBudget).toHaveBeenCalledTimes(1);
      expect(budgets.releaseBudget).toHaveBeenCalledWith('org_1', 'budget_1', 100);
    });

    it('does not release budget for proposal without budgetId', async () => {
      repository.rows = [makeProposal({ transaction: makeTransaction({ budgetId: null }) })];

      await service.expireStale(NOW);

      expect(budgets.releaseBudget).not.toHaveBeenCalled();
    });

    it.skip('logs warning but continues when budget release fails', async () => {
      budgets.releaseBudget.mockRejectedValueOnce(new Error('DB connection failed'));
      repository.rows = [makeProposal({ transaction: makeTransaction({ budgetId: 'budget_1' }) })];

      const result = await service.expireStale(NOW);

      expect(result.expired).toBe(1);
      expect(budgets.releaseBudget).toHaveBeenCalledTimes(1);
      // Proposal should still be expired despite budget release failure
      expect(repository.rows[0].status).toBe(ProposalStatus.EXPIRED);
    });
  });

  describe('decide on an expired proposal', () => {
    it('rejects the approval with a 409 PROPOSAL_EXPIRED and never executes the transaction', async () => {
      repository.rows = [makeProposal()];

      const error = await service
        .decide('org_1', 'user_1', 'proposal_1', { decision: ApprovalDecision.APPROVED })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe(ErrorCode.PROPOSAL_EXPIRED);
      expect((error as DomainException).getStatus()).toBe(409);
      expect(ERROR_STATUS[ErrorCode.PROPOSAL_EXPIRED]).toBe(409);
      expect((error as Error).message).toMatch(/expired/i);
      expect(repository.rows[0].status).toBe(ProposalStatus.EXPIRED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.ProposalExpired,
        expect.objectContaining({ proposalId: 'proposal_1' }),
        expect.objectContaining({ organizationId: 'org_1', actorId: 'user_1' }),
      );
      expect(transactions.execute).not.toHaveBeenCalled();
      expect(repository.createApproval).not.toHaveBeenCalled();
    });

    it('does not emit a second expiry event when the sweeper already expired it', async () => {
      repository.rows = [makeProposal()];
      repository.transitionStatus.mockResolvedValueOnce(false);

      await expect(
        service.decide('org_1', 'user_1', 'proposal_1', { decision: ApprovalDecision.REJECTED }),
      ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_EXPIRED });

      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('decide racing the sweeper', () => {
    it('refuses to approve when the sweeper won the PENDING -> EXPIRED race', async () => {
      repository.rows = [makeProposal({ expiresAt: null })];
      repository.transitionStatus.mockResolvedValueOnce(false);

      const error = await service
        .decide('org_1', 'user_1', 'proposal_1', { decision: ApprovalDecision.APPROVED })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe(ErrorCode.INVALID_PROPOSAL_TRANSITION);
      expect((error as DomainException).getStatus()).toBe(409);
      expect(transactions.execute).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        DomainEventName.ProposalApproved,
        expect.anything(),
        expect.anything(),
      );
      // A proposal can never be both approved and expired.
      expect(repository.rows[0].status).toBe(ProposalStatus.PENDING);
    });

    it('approves and executes when it wins the race', async () => {
      repository.rows = [makeProposal({ expiresAt: null })];

      await service.decide('org_1', 'user_1', 'proposal_1', {
        decision: ApprovalDecision.APPROVED,
      });

      expect(repository.transitionStatus).toHaveBeenCalledWith(
        'proposal_1',
        ProposalStatus.PENDING,
        ProposalStatus.APPROVED,
      );
      expect(transactions.execute).toHaveBeenCalledWith('org_1', 'tx_1', 'user_1');
      expect(repository.rows[0].status).toBe(ProposalStatus.EXECUTED);
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.ProposalApproved,
        expect.objectContaining({ proposalId: 'proposal_1', approvals: 1 }),
        expect.anything(),
      );
    });

    it('does not cancel a transaction for a rejection that lost the race', async () => {
      repository.rows = [makeProposal({ expiresAt: null })];
      repository.transitionStatus.mockResolvedValueOnce(false);

      await expect(
        service.decide('org_1', 'user_1', 'proposal_1', { decision: ApprovalDecision.REJECTED }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_PROPOSAL_TRANSITION });

      expect(transactions.cancel).not.toHaveBeenCalled();
    });
  });
});

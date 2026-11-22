import { describe, expect, it, vi } from 'vitest';
import { ApprovalDecision, Proposal, ProposalStatus } from '@prisma/client';
import { ApprovalService } from './approval.service';
import { ErrorCode } from '../../common/constants/error-codes';

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
    let status = ProposalStatus.PENDING;
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
    ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_EXPIRED, status: 410 });
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
});

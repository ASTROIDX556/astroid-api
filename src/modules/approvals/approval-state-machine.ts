import { ProposalStatus } from '@prisma/client';
import { ErrorCode } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';

/**
 * The complete proposal lifecycle. Approval is multi-signature: votes leave a
 * proposal PENDING until its required threshold is reached, then exactly one
 * guarded PENDING -> APPROVED transition wins the right to execute it.
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  [ProposalStatus.DRAFT]: [ProposalStatus.PENDING],
  [ProposalStatus.PENDING]: [
    ProposalStatus.APPROVED,
    ProposalStatus.REJECTED,
    ProposalStatus.EXPIRED,
  ],
  [ProposalStatus.APPROVED]: [ProposalStatus.EXECUTED],
  [ProposalStatus.REJECTED]: [],
  [ProposalStatus.EXPIRED]: [],
  [ProposalStatus.EXECUTED]: [],
  [ProposalStatus.CANCELLED]: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/** A deterministic 409 for lifecycle violations, including raced transitions. */
export class InvalidProposalTransitionException extends DomainException {
  constructor(from: ProposalStatus, to: ProposalStatus) {
    super(
      ErrorCode.INVALID_PROPOSAL_TRANSITION,
      `Proposal cannot transition from '${from}' to '${to}'`,
      { from, to },
    );
  }
}

export function assertTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidProposalTransitionException(from, to);
  }
}

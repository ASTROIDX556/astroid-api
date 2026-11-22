import { describe, expect, it } from 'vitest';
import { ProposalStatus } from '@prisma/client';
import {
  assertTransition,
  canTransition,
  InvalidProposalTransitionException,
  PROPOSAL_TRANSITIONS,
} from './approval-state-machine';
import { ErrorCode } from '../../common/constants/error-codes';

describe('proposal approval state machine', () => {
  it.each(
    Object.entries(PROPOSAL_TRANSITIONS).flatMap(([from, destinations]) =>
      destinations.map((to) => [from as ProposalStatus, to] as const),
    ),
  )('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [ProposalStatus.PENDING, ProposalStatus.EXECUTED],
    [ProposalStatus.REJECTED, ProposalStatus.APPROVED],
    [ProposalStatus.EXPIRED, ProposalStatus.APPROVED],
    [ProposalStatus.EXECUTED, ProposalStatus.APPROVED],
  ])('rejects %s -> %s with a typed conflict', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidProposalTransitionException);
    try {
      assertTransition(from, to);
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.INVALID_PROPOSAL_TRANSITION, status: 409 });
    }
  });
});

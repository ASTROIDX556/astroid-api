import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentPolicyGuard } from './agent-policy.guard';
import { PolicyService } from '../policy.service';
import { PolicyViolationException } from '../../../common/exceptions/domain.exception';

function createMockContext(body: Record<string, unknown>, user?: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ body, user }),
    }),
  } as unknown as ExecutionContext;
}

describe('AgentPolicyGuard (#451)', () => {
  let policyService: {
    evaluateIntent: ReturnType<typeof vi.fn>;
    checkVelocityLimit: ReturnType<typeof vi.fn>;
  };
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };
  let guard: AgentPolicyGuard;

  beforeEach(() => {
    policyService = {
      evaluateIntent: vi.fn(),
      checkVelocityLimit: vi.fn(),
    };
    reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    };
    guard = new AgentPolicyGuard(
      policyService as unknown as PolicyService,
      reflector as unknown as Reflector,
    );
  });

  it('bypasses evaluation when @RequireAgentPolicy metadata is not enabled', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const ctx = createMockContext({ agentId: 'agt_1', amount: 100 });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(policyService.evaluateIntent).not.toHaveBeenCalled();
  });

  it('allows valid agent transactions that pass spending policy and velocity limits', async () => {
    policyService.evaluateIntent.mockResolvedValue({
      passed: true,
      violations: [],
      requiresApproval: false,
    });
    policyService.checkVelocityLimit.mockResolvedValue(undefined);

    const ctx = createMockContext(
      {
        agentId: 'agt_1',
        walletId: 'wal_1',
        amount: '250.5',
        asset: 'USDC',
        recipientAddress: 'GABC123',
      },
      { id: 'usr_1', organizationId: 'org_1' },
    );

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(policyService.evaluateIntent).toHaveBeenCalledWith({
      organizationId: 'org_1',
      agentId: 'agt_1',
      walletId: 'wal_1',
      asset: 'USDC',
      amount: 250.5,
      recipientAddress: 'GABC123',
    });
    expect(policyService.checkVelocityLimit).toHaveBeenCalledWith(
      'org_1',
      'agt_1',
      250.5,
      'USDC',
      'usr_1',
    );
  });

  it('throws PolicyViolationException with structured violations when policy evaluation fails', async () => {
    policyService.evaluateIntent.mockResolvedValue({
      passed: false,
      requiresApproval: true,
      violations: [
        {
          policyId: 'pol_1',
          policyName: 'Daily USDC Cap',
          rule: 'MAX_PER_TX',
          message: 'Amount exceeds 500 USDC limit',
        },
      ],
    });

    const ctx = createMockContext(
      {
        agentId: 'agt_1',
        walletId: 'wal_1',
        amount: 1000,
        asset: 'USDC',
        recipientAddress: 'GABC123',
      },
      { id: 'usr_1', organizationId: 'org_1' },
    );

    await expect(guard.canActivate(ctx)).rejects.toThrow(PolicyViolationException);
    expect(policyService.checkVelocityLimit).not.toHaveBeenCalled();
  });
});

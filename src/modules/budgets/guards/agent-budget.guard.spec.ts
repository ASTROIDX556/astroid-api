import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BudgetService } from '../budget.service';
import { AgentBudgetGuard } from './agent-budget.guard';

function makeContext(body: Record<string, unknown>, organizationId = 'org-1') {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, user: { organizationId } }),
    }),
  } as unknown as ExecutionContext;
}

describe('AgentBudgetGuard', () => {
  it('checks the active agent budget using the authenticated organization', async () => {
    const budgetService = {
      assertAgentBudgetWithinLimit: vi.fn().mockResolvedValue(undefined),
    } as unknown as BudgetService;
    const guard = new AgentBudgetGuard(budgetService);

    await expect(
      guard.canActivate(
        makeContext({ agentId: 'agent-1', amount: '25.5000000', asset: 'USDC' }),
      ),
    ).resolves.toBe(true);

    expect(budgetService.assertAgentBudgetWithinLimit).toHaveBeenCalledWith(
      'org-1',
      'agent-1',
      'USDC',
      25.5,
    );
  });

  it('propagates a forbidden response when the active limit is exceeded', async () => {
    const budgetService = {
      assertAgentBudgetWithinLimit: vi
        .fn()
        .mockRejectedValue(new ForbiddenException('Budget exceeded')),
    } as unknown as BudgetService;
    const guard = new AgentBudgetGuard(budgetService);

    await expect(
      guard.canActivate(makeContext({ agentId: 'agent-1', amount: '101', asset: 'USDC' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves malformed payloads for the transaction schema pipe to reject', async () => {
    const budgetService = {
      assertAgentBudgetWithinLimit: vi.fn(),
    } as unknown as BudgetService;
    const guard = new AgentBudgetGuard(budgetService);

    await expect(
      guard.canActivate(makeContext({ agentId: 'agent-1', amount: '-1', asset: 'USDC' })),
    ).resolves.toBe(true);
    expect(budgetService.assertAgentBudgetWithinLimit).not.toHaveBeenCalled();
  });
});
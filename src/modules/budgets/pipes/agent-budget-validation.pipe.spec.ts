import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CreateTransactionInput } from '../../transactions/transaction.dto';
import { BudgetService } from '../budget.service';
import { PolicyEvaluatorService } from '../services/policy-evaluator.service';
import { AgentBudgetValidationPipe } from './agent-budget-validation.pipe';

describe('AgentBudgetValidationPipe', () => {
  const transaction = {
    walletId: 'wallet-id',
    budgetId: 'budget-id',
    asset: 'USDC',
    amount: '12.5',
    recipientAddress: 'GABC',
    metadata: {},
  } as CreateTransactionInput;

  it('allows a transaction when its budget has sufficient headroom', async () => {
    const assertWithinBudget = vi.fn().mockResolvedValue(undefined);
    const pipe = new AgentBudgetValidationPipe(
      { user: { organizationId: 'org-id' } } as never,
      { assertWithinBudget } as unknown as BudgetService,
      { evaluate: vi.fn() } as unknown as PolicyEvaluatorService,
    );

    await expect(pipe.transform(transaction)).resolves.toBe(transaction);
    expect(assertWithinBudget).toHaveBeenCalledWith('org-id', 'budget-id', 12.5);
  });

  it('rejects when the selected budget check fails', async () => {
    const assertWithinBudget = vi.fn().mockRejectedValue(new Error('Budget limit exceeded'));
    const pipe = new AgentBudgetValidationPipe(
      { user: { organizationId: 'org-id' } } as never,
      { assertWithinBudget } as unknown as BudgetService,
      { evaluate: vi.fn() } as unknown as PolicyEvaluatorService,
    );

    await expect(pipe.transform(transaction)).rejects.toThrow('Budget limit exceeded');
  });

  it('does not require a budget lookup when no budget is selected', async () => {
    const assertWithinBudget = vi.fn();
    const pipe = new AgentBudgetValidationPipe(
      { user: { organizationId: 'org-id' } } as never,
      { assertWithinBudget } as unknown as BudgetService,
      { evaluate: vi.fn() } as unknown as PolicyEvaluatorService,
    );
    const unbudgetedTransaction = { ...transaction, budgetId: undefined };

    await expect(pipe.transform(unbudgetedTransaction)).resolves.toBe(unbudgetedTransaction);
    expect(assertWithinBudget).not.toHaveBeenCalled();
  });

  it('allows an agent transaction when active spending policies pass', async () => {
    const evaluate = vi.fn().mockResolvedValue({ allowed: true });
    const pipe = new AgentBudgetValidationPipe(
      { user: { organizationId: 'org-id' } } as never,
      { assertWithinBudget: vi.fn() } as unknown as BudgetService,
      { evaluate } as unknown as PolicyEvaluatorService,
    );
    const agentTransaction = { ...transaction, budgetId: undefined, agentId: 'agent-id' };

    await expect(pipe.transform(agentTransaction)).resolves.toBe(agentTransaction);
    expect(evaluate).toHaveBeenCalledWith({
      organizationId: 'org-id',
      agentId: 'agent-id',
      walletId: 'wallet-id',
      asset: 'USDC',
      amount: '12.5',
      recipientAddress: 'GABC',
    });
  });

  it('rejects an agent transaction blocked by an active spending policy', async () => {
    const pipe = new AgentBudgetValidationPipe(
      { user: { organizationId: 'org-id' } } as never,
      { assertWithinBudget: vi.fn() } as unknown as BudgetService,
      {
        evaluate: vi.fn().mockResolvedValue({
          allowed: false,
          reason: 'Daily limit exceeded',
          remainingLimit: '0.0000000',
        }),
      } as unknown as PolicyEvaluatorService,
    );

    await expect(
      pipe.transform({ ...transaction, budgetId: undefined, agentId: 'agent-id' }),
    ).rejects.toThrow('Daily limit exceeded');
  });

  it('requires authenticated organization context for a budgeted transaction', async () => {
    const pipe = new AgentBudgetValidationPipe(
      {} as never,
      { assertWithinBudget: vi.fn() } as unknown as BudgetService,
      { evaluate: vi.fn() } as unknown as PolicyEvaluatorService,
    );

    await expect(pipe.transform(transaction)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

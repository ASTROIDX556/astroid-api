import { Inject, Injectable, PipeTransform, Scope, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { PolicyViolationException } from '../../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { CreateTransactionInput } from '../../transactions/transaction.dto';
import { BudgetService } from '../budget.service';
import { PolicyEvaluatorService } from '../services/policy-evaluator.service';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/** Checks a transaction's selected budget before governance work begins. */
@Injectable({ scope: Scope.REQUEST })
export class AgentBudgetValidationPipe implements PipeTransform<CreateTransactionInput> {
  constructor(
    @Inject(REQUEST) private readonly request: AuthenticatedRequest,
    private readonly budgets: BudgetService,
    private readonly policies: PolicyEvaluatorService,
  ) {}

  async transform(value: CreateTransactionInput): Promise<CreateTransactionInput> {
    if (!value.budgetId && !value.agentId) {
      return value;
    }

    const organizationId = this.request.user?.organizationId;
    if (!organizationId) {
      throw new UnauthorizedException(
        'An authenticated organization is required for budget validation',
      );
    }

    if (value.budgetId) {
      await this.budgets.assertWithinBudget(organizationId, value.budgetId, Number(value.amount));
    }

    if (value.agentId) {
      const result = await this.policies.evaluate({
        organizationId,
        agentId: value.agentId,
        walletId: value.walletId,
        asset: value.asset,
        amount: value.amount,
        recipientAddress: value.recipientAddress,
      });
      if (!result.allowed) {
        throw new PolicyViolationException(
          result.reason ?? 'Transaction is blocked by an active spending policy',
          { agentId: value.agentId, remainingLimit: result.remainingLimit },
        );
      }
    }

    return value;
  }
}

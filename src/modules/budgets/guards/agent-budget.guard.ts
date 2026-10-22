import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { BudgetService } from '../budget.service';

@Injectable()
export class AgentBudgetGuard implements CanActivate {
  constructor(private readonly budgetService: BudgetService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const body = request.body as Record<string, unknown> | undefined;
    const agentId = body?.agentId;
    const amount = body?.amount;

    // The Zod pipe returns the canonical 400 for malformed transaction bodies.
    if (
      typeof agentId !== 'string' ||
      typeof amount !== 'string' ||
      !/^\d+(\.\d{1,7})?$/.test(amount) ||
      !Number.isFinite(Number(amount))
    ) {
      return true;
    }

    const organizationId = request.user?.organizationId;
    if (!organizationId) return true;

    await this.budgetService.assertAgentBudgetWithinLimit(
      organizationId,
      agentId,
      typeof body?.asset === 'string' ? body.asset : 'XLM',
      Number(amount),
    );
    return true;
  }
}
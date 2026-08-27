import { Injectable } from '@nestjs/common';
import { Policy, Prisma } from '@prisma/client';
import { PolicyRepository } from './policy.repository';
import { PolicyEngine } from './policy.engine';
import { CreatePolicyInput, SimulatePolicyInput, UpdatePolicyInput } from './policy.dto';
import {
  EvaluablePolicy,
  PolicyConfiguration,
  PolicyEvaluationResult,
  TransactionIntent,
  policyConfigurationSchemaStrict,
} from './policy.types';
import { NotFoundException, VelocityLimitExceededException, ValidationException } from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { PrismaService } from '../../database/prisma.service';

const SORTABLE = ['createdAt', 'priority', 'name', 'type'];

/**
 * Manages policy definitions and exposes evaluation to other modules. Wraps the
 * pure {@link PolicyEngine} with persistence, event emission and simulation.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly repository: PolicyRepository,
    private readonly engine: PolicyEngine,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreatePolicyInput) {
    // Validate configuration using strict schema
    const validationResult = policyConfigurationSchemaStrict.safeParse(input.configuration);
    if (!validationResult.success) {
      throw new ValidationException(
        'Invalid policy configuration',
        validationResult.error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      );
    }

    const policy = await this.repository.create({
      organization: { connect: { id: organizationId } },
      ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
      name: input.name,
      description: input.description,
      type: input.type,
      configuration: validationResult.data as Prisma.InputJsonValue,
      priority: input.priority,
      enabled: input.enabled,
    });
    await this.eventBus.emit(
      DomainEventName.PolicyCreated,
      { policyId: policy.id, name: policy.name, type: policy.type },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: policy.id },
    );
    return policy;
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.PolicyWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query.page, query.limit));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Policy> {
    const policy = await this.repository.findById(organizationId, id);
    if (!policy) {
      throw new NotFoundException('Policy', id);
    }
    return policy;
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdatePolicyInput) {
    await this.getOrThrow(organizationId, id);
    const data: Prisma.PolicyUpdateInput = {
      name: input.name,
      description: input.description,
      type: input.type,
      priority: input.priority,
      enabled: input.enabled,
    };
    if (input.configuration) {
      // Validate configuration using strict schema
      const validationResult = policyConfigurationSchemaStrict.safeParse(input.configuration);
      if (!validationResult.success) {
        throw new ValidationException(
          'Invalid policy configuration',
          validationResult.error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        );
      }
      data.configuration = validationResult.data as Prisma.InputJsonValue;
    }
    const policy = await this.repository.update(id, data);
    await this.eventBus.emit(
      DomainEventName.PolicyUpdated,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return policy;
  }

  async remove(organizationId: string, actorId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    await this.repository.softDelete(id);
    await this.eventBus.emit(
      DomainEventName.PolicyDeleted,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return { id, deleted: true };
  }

  /**
   * Evaluates an intent against all applicable stored policies. Emits a
   * PolicyEvaluated event (and PolicyViolated on failure) for the ledger.
   */
  async evaluateIntent(
    intent: TransactionIntent,
    actorId?: string,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.repository.findActiveForEvaluation(
      intent.organizationId,
      intent.agentId,
    );
    const result = this.engine.evaluate(intent, policies.map(toEvaluable));

    await this.eventBus.emit(
      DomainEventName.PolicyEvaluated,
      {
        passed: result.passed,
        requiresApproval: result.requiresApproval,
        violations: result.violations.map((v) => v.code),
      },
      {
        organizationId: intent.organizationId,
        actorId,
        aggregateType: 'policy',
        aggregateId: result.matchedPolicyId,
      },
    );

    if (!result.passed) {
      await this.eventBus.emit(
        DomainEventName.PolicyViolated,
        { violations: result.violations },
        {
          organizationId: intent.organizationId,
          actorId,
          aggregateType: 'policy',
          aggregateId: result.matchedPolicyId,
        },
      );
    }
    return result;
  }

  /** POST /policies/simulate — dry run without creating a transaction. */
  async simulate(organizationId: string, input: SimulatePolicyInput) {
    const intent: TransactionIntent = {
      organizationId,
      agentId: input.agentId,
      walletId: input.walletId,
      asset: input.asset,
      amount: input.amount,
      recipientAddress: input.recipientAddress,
      spentToday: input.spentToday,
      spentThisWeek: input.spentThisWeek,
      spentThisMonth: input.spentThisMonth,
    };
    const policies = await this.repository.findActiveForEvaluation(organizationId, input.agentId);
    const result = this.engine.evaluate(intent, policies.map(toEvaluable));
    return {
      passed: result.passed,
      requiresApproval: result.requiresApproval,
      violations: result.violations,
      evaluatedPolicies: result.evaluatedPolicyIds.length,
    };
  }

  /**
   * Check velocity limit for an agent's spending within a rolling 24-hour window.
   * This acts as a circuit breaker to prevent rapid draining of wallets.
   */
  async checkVelocityLimit(agentId: string, amount: number, assetCode: string): Promise<void> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Query historical agent transactions from the last 24 hours
    const transactions = await this.prisma.transaction.findMany({
      where: {
        agentId,
        status: { in: ['COMPLETED', 'CONFIRMED'] },
        asset: assetCode,
        createdAt: { gte: twentyFourHoursAgo },
      },
      select: {
        amount: true,
      },
    });

    // Sum up transaction volumes
    const spentInWindow = transactions.reduce(
      (sum, tx) => sum + Number(tx.amount),
      0,
    );

    // Retrieve the agent's active daily limit from policies
    const policies = await this.repository.findActiveForEvaluationByAgent(agentId);
    const dailyLimitPolicy = policies.find((policy) => {
      const config = policy.configuration as PolicyConfiguration;
      return config.dailyLimit !== undefined && config.dailyLimit > 0;
    });

    if (!dailyLimitPolicy) {
      // No daily limit configured, allow the transaction
      return;
    }

    const config = dailyLimitPolicy.configuration as PolicyConfiguration;
    const dailyLimit = config.dailyLimit!;

    // Check if the pending transaction would exceed the limit
    if (spentInWindow + amount > dailyLimit) {
      throw new VelocityLimitExceededException(
        `Daily velocity limit exceeded. Spent: ${spentInWindow}, Pending: ${amount}, Limit: ${dailyLimit}`,
        {
          spentInWindow,
          pendingAmount: amount,
          limit: dailyLimit,
          assetCode,
        },
      );
    }
  }
}

/** Projects a Prisma Policy into the engine's decoupled EvaluablePolicy shape. */
function toEvaluable(policy: Policy): EvaluablePolicy {
  return {
    id: policy.id,
    name: policy.name,
    priority: policy.priority,
    enabled: policy.enabled,
    agentId: policy.agentId,
    configuration: (policy.configuration as PolicyConfiguration) ?? {},
    overrideLimit: policy.overrideLimit?.toNumber() ?? null,
    overrideUntil: policy.overrideUntil,
    originalLimit: policy.originalLimit?.toNumber() ?? null,
  };
}

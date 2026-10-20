import { Injectable } from '@nestjs/common';
import { Policy } from '@prisma/client';
import { SpendingPolicyService } from './spending-policy.service';
import { PolicyEngine } from './policy.engine';
import { PriceOracleService } from './price-oracle.service';
import { AssetRegistryService } from './asset-registry.service';
import { CreatePolicyInput, SimulatePolicyInput, UpdatePolicyInput } from './policy.dto';
import {
  EvaluablePolicy,
  PolicyConfiguration,
  PolicyEvaluationResult,
  PolicyViolation,
  SpendPeriods,
  TransactionIntent,
} from './policy.types';
import { PaginationQuery } from '../../common/helpers/pagination';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';

/** Policies that do not declare a base currency share the "no conversion" group. */
const NO_BASE_CURRENCY = '';

/**
 * Controller-facing façade over the policy domain. Delegates persistence and
 * spending-policy enforcement to {@link SpendingPolicyService} and wraps every
 * mutation with the domain events the audit ledger depends on.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly spendingPolicyService: SpendingPolicyService,
    private readonly engine: PolicyEngine,
    private readonly eventBus: EventBusService,
    private readonly priceOracle: PriceOracleService,
    private readonly assetRegistry: AssetRegistryService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreatePolicyInput) {
    const policy = await this.spendingPolicyService.create(organizationId, input);
    await this.eventBus.emit(
      DomainEventName.PolicyCreated,
      { policyId: policy.id, name: policy.name, type: policy.type },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: policy.id },
    );
    return policy;
  }

  list(organizationId: string, query: PaginationQuery) {
    return this.spendingPolicyService.list(organizationId, query);
  }

  getOrThrow(organizationId: string, id: string): Promise<Policy> {
    return this.spendingPolicyService.getOrThrow(organizationId, id);
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdatePolicyInput) {
    const policy = await this.spendingPolicyService.update(organizationId, id, input);
    await this.eventBus.emit(
      DomainEventName.PolicyUpdated,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return policy;
  }

  async remove(organizationId: string, actorId: string, id: string) {
    const result = await this.spendingPolicyService.remove(organizationId, id);
    await this.eventBus.emit(
      DomainEventName.PolicyDeleted,
      { policyId: id },
      { organizationId, actorId, aggregateType: 'policy', aggregateId: id },
    );
    return result;
  }

  /**
   * Evaluates an intent against all applicable stored policies. Emits a
   * PolicyEvaluated event (and PolicyViolated on failure) for the ledger.
   * Also persists an audit log entry for compliance tracking.
   *
   * Policies may denominate their limits in a base currency (`baseCurrency`).
   * In that case the transfer amounts — and the spend already accumulated for
   * the asset — are converted into that currency before the comparison. A
   * missing or stale price aborts the evaluation with a
   * {@link PriceUnavailableException} so a limit can never be bypassed by
   * treating an unknown price as zero.
   */
  async evaluateIntent(
    intent: TransactionIntent,
    actorId?: string,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.spendingPolicyService.listActiveForEvaluation(
      intent.organizationId,
      intent.agentId,
    );
    const result = await this.evaluateAgainstPolicies(intent, policies);

    await this.eventBus.emit(
      DomainEventName.PolicyEvaluated,
      {
        passed: result.passed,
        requiresApproval: result.requiresApproval,
        violations: result.violations.map((v) => v.code),
        amount: intent.amount,
        asset: intent.asset,
        recipientAddress: intent.recipientAddress,
        transfers: intent.transfers?.map((leg) => ({ asset: leg.asset, amount: leg.amount })),
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

    if (actorId) {
      await this.spendingPolicyService.recordEvaluationAudit(intent, result, actorId);
    }

    return result;
  }

  /** POST /policies/simulate — dry run without creating a transaction. */
  async simulate(organizationId: string, input: SimulatePolicyInput) {
    const transfers = input.transfers?.map((leg) => ({
      asset: this.assetRegistry.canonicalize(leg.asset),
      amount: Number(leg.amount),
    }));
    const intent: TransactionIntent = {
      organizationId,
      agentId: input.agentId,
      walletId: input.walletId,
      asset: input.asset
        ? this.assetRegistry.canonicalize(input.asset)
        : transfers?.[0]?.asset ?? 'XLM',
      amount: input.amount ?? transfers?.[0]?.amount ?? 0,
      recipientAddress: input.recipientAddress,
      spentToday: input.spentToday,
      spentThisWeek: input.spentThisWeek,
      spentThisMonth: input.spentThisMonth,
      ...(transfers ? { transfers } : {}),
    };
    const policies = await this.spendingPolicyService.listActiveForEvaluation(
      organizationId,
      input.agentId,
    );
    const result = await this.evaluateAgainstPolicies(intent, policies);
    return {
      passed: result.passed,
      requiresApproval: result.requiresApproval,
      violations: result.violations,
      evaluatedPolicies: result.evaluatedPolicyIds.length,
    };
  }

  /**
   * Checks the rolling 24-hour velocity limit for an agent's spending. Acts as
   * a circuit breaker to prevent rapid draining of wallets. Delegates the
   * actual enforcement to {@link SpendingPolicyService}; `organizationId` and
   * `actorId` are accepted for call-site symmetry with the rest of the
   * transaction governance pipeline but are not needed by the check itself.
   */
  checkVelocityLimit(
    _organizationId: string,
    agentId: string,
    amount: number,
    assetCode: string,
    _actorId?: string,
  ): Promise<void> {
    return this.spendingPolicyService.checkVelocityLimit(agentId, amount, assetCode);
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Evaluates an intent against the supplied policies.
   *
   * Policies are grouped by the currency their limits are denominated in. Each
   * group is evaluated with an intent whose amounts were converted into that
   * currency, so the pure engine only ever compares values in the same unit.
   */
  private async evaluateAgainstPolicies(
    intent: TransactionIntent,
    policies: Policy[],
  ): Promise<PolicyEvaluationResult> {
    const evaluable = policies.map(toEvaluable);
    const groups = this.groupByLimitCurrency(evaluable);

    const violations: PolicyViolation[] = [];
    const evaluated: Array<{ id: string; index: number }> = [];
    let requiresApproval = false;
    let matchedPolicyId: string | undefined;

    for (const [currency, group] of groups) {
      const prepared = await this.prepareIntent(intent, currency);
      const result = this.engine.evaluate(prepared, group);
      violations.push(...result.violations);
      for (const id of result.evaluatedPolicyIds) {
        const index = evaluable.findIndex((policy) => policy.id === id);
        evaluated.push({ id, index: index === -1 ? Number.MAX_SAFE_INTEGER : index });
      }
      requiresApproval = requiresApproval || result.requiresApproval;
      matchedPolicyId = matchedPolicyId ?? result.matchedPolicyId;
    }

    evaluated.sort((left, right) => left.index - right.index);

    return {
      passed: violations.length === 0,
      requiresApproval,
      violations,
      evaluatedPolicyIds: evaluated.map((entry) => entry.id),
      matchedPolicyId,
    };
  }

  /** Groups policies by the currency their limits are denominated in. */
  private groupByLimitCurrency(policies: EvaluablePolicy[]): Map<string, EvaluablePolicy[]> {
    const groups = new Map<string, EvaluablePolicy[]>();
    for (const policy of policies) {
      const currency = (policy.configuration.baseCurrency ?? NO_BASE_CURRENCY).toUpperCase();
      const group = groups.get(currency);
      if (group) {
        group.push(policy);
      } else {
        groups.set(currency, [policy]);
      }
    }
    return groups;
  }

  /**
   * Returns the intent with its amounts expressed in the limit currency.
   *
   * Without a base currency the intent is returned untouched, so policies that
   * do not opt into conversion keep their previous behaviour exactly.
   */
  private async prepareIntent(
    intent: TransactionIntent,
    currency: string,
  ): Promise<TransactionIntent> {
    if (!currency) {
      return intent;
    }

    const transfers = intent.transfers
      ? await Promise.all(
          intent.transfers.map(async (leg) => ({
            ...leg,
            amount: await this.priceOracle.convert(leg.amount, leg.asset, currency),
          })),
        )
      : undefined;

    const amount =
      transfers === undefined
        ? await this.priceOracle.convert(intent.amount, intent.asset, currency)
        : intent.amount;

    const spentByAsset = intent.spentByAsset
      ? await this.convertSpendByAsset(intent.spentByAsset, currency)
      : undefined;

    const flatSpend =
      intent.spentToday === undefined &&
      intent.spentThisWeek === undefined &&
      intent.spentThisMonth === undefined
        ? undefined
        : {
            spentToday:
              intent.spentToday === undefined
                ? undefined
                : await this.priceOracle.convert(intent.spentToday, intent.asset, currency),
            spentThisWeek:
              intent.spentThisWeek === undefined
                ? undefined
                : await this.priceOracle.convert(intent.spentThisWeek, intent.asset, currency),
            spentThisMonth:
              intent.spentThisMonth === undefined
                ? undefined
                : await this.priceOracle.convert(intent.spentThisMonth, intent.asset, currency),
          };

    return {
      ...intent,
      amount,
      ...(transfers ? { transfers } : {}),
      ...(spentByAsset ? { spentByAsset } : {}),
      ...(flatSpend ? { ...flatSpend } : {}),
      limitCurrency: currency,
    };
  }

  /** Converts the per-asset spend aggregates into the limit currency. */
  private async convertSpendByAsset(
    spentByAsset: Record<string, SpendPeriods>,
    currency: string,
  ): Promise<Record<string, SpendPeriods>> {
    const entries = await Promise.all(
      Object.entries(spentByAsset).map(async ([asset, spend]) => {
        const converted: SpendPeriods = {
          spentToday: await this.priceOracle.convert(spend.spentToday, asset, currency),
          spentThisWeek: await this.priceOracle.convert(spend.spentThisWeek, asset, currency),
          spentThisMonth: await this.priceOracle.convert(spend.spentThisMonth, asset, currency),
        };
        return [asset, converted] as const;
      }),
    );
    return Object.fromEntries(entries);
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

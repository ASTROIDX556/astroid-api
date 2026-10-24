import { Injectable } from '@nestjs/common';
import {
  EvaluablePolicy,
  PolicyConfiguration,
  PolicyEvaluationResult,
  PolicyRuleCondition,
  PolicyViolation,
  TransactionIntent,
} from './policy.types';

/** Weekday indices, matching `Date.prototype.getUTCDay()`. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Local time of an instant, resolved in a specific IANA time zone. */
interface LocalTime {
  hour: number;
  dayOfWeek: number;
}

/**
 * Pure, deterministic policy evaluation engine. Given a transaction intent and
 * the set of applicable policies, it returns every violation and whether human
 * approval is required. Contains NO I/O — it is trivially unit-testable and is
 * the heart of Astroid's "AI should never spend money freely" guarantee.
 */
@Injectable()
export class PolicyEngine {
  /**
   * Evaluates an intent against all supplied policies (already scoped to the
   * org + agent). Policies are considered in priority order (lower number =
   * higher priority). Approval is required if ANY policy demands it.
   */
  evaluate(intent: TransactionIntent, policies: EvaluablePolicy[]): PolicyEvaluationResult {
    const active = policies
      .filter((policy) => policy.enabled)
      .filter((policy) => this.appliesToAgent(policy, intent))
      .sort((a, b) => a.priority - b.priority);

    const violations: PolicyViolation[] = [];
    let requiresApproval = false;
    const at = intent.at ?? new Date();

    for (const policy of active) {
      const config = policy.configuration;
      const legs = intent.transfers?.length
        ? intent.transfers
        : [{ asset: intent.asset, amount: intent.amount, recipientAddress: intent.recipientAddress }];
      for (const leg of legs) {
        const assetCode = leg.asset.split(':', 1)[0].toUpperCase();
        const assetLimit = config.assetLimits?.[assetCode] ?? config.assetLimits?.[assetCode.toLowerCase()];
        const legConfig = assetLimit
          ? { ...config, maxAmount: assetLimit.maxAmount ?? config.maxAmount, minAmount: assetLimit.minAmount ?? config.minAmount }
          : config;
        const legIntent = {
          ...intent,
          asset: leg.asset,
          amount: leg.amount,
          recipientAddress: leg.recipientAddress ?? intent.recipientAddress,
        };
        violations.push(...this.checkAmount(policy, legConfig, legIntent, at));
        violations.push(...this.checkAssets(policy, legConfig, legIntent));
        violations.push(...this.checkRecipients(policy, legConfig, legIntent));
        violations.push(...this.checkPeriodicLimits(policy, legConfig, legIntent));
      }
      violations.push(...this.checkTimeWindow(policy, config, at));
      violations.push(...this.checkVelocity(policy, config, intent));
      violations.push(...this.checkRuleGroups(policy, config, intent, at));
      violations.push(...this.checkEmergencyLock(policy, config));
      if (this.demandsApproval(config, intent)) {
        requiresApproval = true;
      }
    }

    return {
      passed: violations.length === 0,
      requiresApproval,
      violations,
      evaluatedPolicyIds: active.map((policy) => policy.id),
      matchedPolicyId: active[0]?.id,
    };
  }

  private appliesToAgent(policy: EvaluablePolicy, intent: TransactionIntent): boolean {
    // A policy with no agentId is organization-wide; otherwise it must match.
    return !policy.agentId || policy.agentId === intent.agentId;
  }

  private checkAmount(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    intent: TransactionIntent,
    at: Date,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const effectiveMax = this.effectiveMaxAmount(policy, config, at);
    if (effectiveMax !== undefined && intent.amount > effectiveMax) {
      out.push(
        this.violation(
          policy,
          'MAX_AMOUNT_EXCEEDED',
          `Amount ${intent.amount}${intent.limitCurrency ? ` ${intent.limitCurrency}` : ''} exceeds maximum ${effectiveMax}${intent.limitCurrency ? ` ${intent.limitCurrency}` : ''}`,
        ),
      );
    }
    if (config.minAmount !== undefined && intent.amount < config.minAmount) {
      out.push(
        this.violation(
          policy,
          'MIN_AMOUNT_NOT_MET',
          `Amount ${intent.amount}${intent.limitCurrency ? ` ${intent.limitCurrency}` : ''} is below minimum ${config.minAmount}${intent.limitCurrency ? ` ${intent.limitCurrency}` : ''}`,
        ),
      );
    }
    return out;
  }

  // Resolves the effective max amount for a policy at a point in time. When a
  // temporary override is active (overrideLimit set, overrideUntil in the
  // future), the overrideLimit wins. Otherwise the engine falls back to the
  // recorded originalLimit, or the configured maxAmount when no override was
  // ever captured.
  private effectiveMaxAmount(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    at: Date,
  ): number | undefined {
    const overrideActive =
      policy.overrideLimit != null &&
      policy.overrideUntil != null &&
      at <= policy.overrideUntil;
    if (overrideActive) {
      return policy.overrideLimit ?? undefined;
    }
    return policy.originalLimit ?? config.maxAmount;
  }

  private checkAssets(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    intent: TransactionIntent,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    if (config.allowedAssets && !config.allowedAssets.includes(intent.asset)) {
      out.push(
        this.violation(policy, 'ASSET_NOT_ALLOWED', `Asset ${intent.asset} is not in the allow list`),
      );
    }
    if (config.blockedAssets && config.blockedAssets.includes(intent.asset)) {
      out.push(this.violation(policy, 'ASSET_BLOCKED', `Asset ${intent.asset} is blocked`));
    }
    return out;
  }

  private checkRecipients(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    intent: TransactionIntent,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const recipient = intent.recipientAddress;
    if (config.allowedRecipients && !config.allowedRecipients.includes(recipient)) {
      out.push(
        this.violation(
          policy,
          'RECIPIENT_NOT_ALLOWED',
          `Recipient ${recipient} is not in the allow list`,
        ),
      );
    }
    if (config.blockedRecipients && config.blockedRecipients.includes(recipient)) {
      out.push(this.violation(policy, 'RECIPIENT_BLOCKED', `Recipient ${recipient} is blocked`));
    }
    return out;
  }

  private checkPeriodicLimits(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    intent: TransactionIntent,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const checks: Array<[number | undefined, number | undefined, string, string]> = [
      [config.dailyLimit, intent.spentToday, 'DAILY_LIMIT_EXCEEDED', 'daily'],
      [config.weeklyLimit, intent.spentThisWeek, 'WEEKLY_LIMIT_EXCEEDED', 'weekly'],
      [config.monthlyLimit, intent.spentThisMonth, 'MONTHLY_LIMIT_EXCEEDED', 'monthly'],
    ];
    for (const [limit, spent, code, label] of checks) {
      if (limit === undefined) {
        continue;
      }
      const projected = (spent ?? 0) + intent.amount;
      if (projected > limit) {
        out.push(
          this.violation(
            policy,
            code,
            `Projected ${label} spend ${projected} exceeds limit ${limit}`,
          ),
        );
      }
    }
    return out;
  }

  private checkTimeWindow(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    at: Date,
  ): PolicyViolation[] {
    if (!config.timeWindow) {
      return [];
    }
    const { startHour, endHour, days, timezone } = config.timeWindow;
    const local = this.resolveLocalTime(at, timezone);
    const withinHours = local.hour >= startHour && local.hour < endHour;
    const withinDays = !days || days.includes(local.dayOfWeek);
    if (!withinHours || !withinDays) {
      return [
        this.violation(
          policy,
          'OUTSIDE_TIME_WINDOW',
          `Transaction attempted outside the allowed time window (${startHour}:00-${endHour}:00 ${
            timezone ?? 'UTC'
          })`,
        ),
      ];
    }
    return [];
  }

  /**
   * Enforces the velocity rule: at most `maxTransactions` may be executed
   * inside the configured rolling window. The window count is supplied by the
   * caller through `intent.transactionCount`, so the engine stays pure.
   */
  private checkVelocity(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    intent: TransactionIntent,
  ): PolicyViolation[] {
    const velocity = config.velocity;
    if (!velocity) {
      return [];
    }

    const executed =
      intent.transactionCounts?.[velocity.window] ?? intent.transactionCount ?? 0;
    if (executed < velocity.maxTransactions) {
      return [];
    }

    return [
      this.violation(
        policy,
        'VELOCITY_LIMIT_EXCEEDED',
        `Transaction count ${executed} reaches the velocity limit of ${velocity.maxTransactions} per ${velocity.window}`,
      ),
    ];
  }

  /**
   * Evaluates the multi-condition rule groups of a policy. A group holds when
   * its conditions satisfy the group's logic (`AND` / `OR`); a group that does
   * not hold produces one violation naming the failed conditions.
   */
  private checkRuleGroups(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    intent: TransactionIntent,
    at: Date,
  ): PolicyViolation[] {
    const groups = config.rules;
    if (!groups || groups.length === 0) {
      return [];
    }

    const out: PolicyViolation[] = [];
    for (const group of groups) {
      const failed = group.conditions.filter(
        (condition) => !this.evaluateCondition(condition, intent, at),
      );

      const holds =
        group.logic === 'OR' ? failed.length < group.conditions.length : failed.length === 0;
      if (holds) {
        continue;
      }

      const label = group.id ?? `rule-${out.length + 1}`;
      out.push(
        this.violation(
          policy,
          'RULE_GROUP_VIOLATED',
          `Rule group '${label}' was not satisfied: ${failed
            .map((condition) => this.describeCondition(condition))
            .join(', ')}`,
        ),
      );
    }
    return out;
  }

  /** Evaluates a single rule condition against the intent. */
  private evaluateCondition(
    condition: PolicyRuleCondition,
    intent: TransactionIntent,
    at: Date,
  ): boolean {
    const actual = this.resolveConditionValue(condition.field, intent, at);

    switch (condition.operator) {
      case 'eq':
        return actual === condition.value;
      case 'neq':
        return actual !== condition.value;
      case 'gt':
        return typeof actual === 'number' && actual > Number(condition.value);
      case 'gte':
        return typeof actual === 'number' && actual >= Number(condition.value);
      case 'lt':
        return typeof actual === 'number' && actual < Number(condition.value);
      case 'lte':
        return typeof actual === 'number' && actual <= Number(condition.value);
      case 'in':
        return Array.isArray(condition.value)
          ? condition.value.includes(String(actual))
          : false;
      case 'notIn':
        return Array.isArray(condition.value)
          ? !condition.value.includes(String(actual))
          : false;
      default:
        return false;
    }
  }

  /** Resolves the value a condition is compared against. */
  private resolveConditionValue(
    field: PolicyRuleCondition['field'],
    intent: TransactionIntent,
    at: Date,
  ): string | number | undefined {
    switch (field) {
      case 'amount':
        return intent.amount;
      case 'asset':
        return intent.asset;
      case 'recipientAddress':
        return intent.recipientAddress;
      case 'agentId':
        return intent.agentId;
      case 'hourOfDay':
        return this.resolveLocalTime(at).hour;
      case 'dayOfWeek':
        return this.resolveLocalTime(at).dayOfWeek;
      case 'transactionCount':
        return intent.transactionCount ?? 0;
      default:
        return undefined;
    }
  }

  /** Human readable description of a condition, used in violation messages. */
  private describeCondition(condition: PolicyRuleCondition): string {
    return `${condition.field} ${condition.operator} ${JSON.stringify(condition.value)}`;
  }

  /**
   * Resolves the local hour and weekday of an instant. The time zone defaults
   * to UTC; an unknown zone falls back to UTC rather than failing the check.
   */
  private resolveLocalTime(at: Date, timeZone?: string): LocalTime {
    if (!timeZone) {
      return { hour: at.getUTCHours(), dayOfWeek: at.getUTCDay() };
    }

    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        hourCycle: 'h23',
        weekday: 'short',
      });
      const parts = formatter.formatToParts(at);
      const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) % 24;
      const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
      return { hour, dayOfWeek: WEEKDAY_INDEX[weekday] ?? 0 };
    } catch {
      return { hour: at.getUTCHours(), dayOfWeek: at.getUTCDay() };
    }
  }

  private checkEmergencyLock(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
  ): PolicyViolation[] {
    if (config.emergencyLock) {
      return [
        this.violation(
          policy,
          'EMERGENCY_LOCK',
          'Spending is currently disabled by an emergency lock policy',
        ),
      ];
    }
    return [];
  }

  private demandsApproval(config: PolicyConfiguration, intent: TransactionIntent): boolean {
    if (config.requiresApproval) {
      return true;
    }
    if (config.approvalThreshold !== undefined && intent.amount >= config.approvalThreshold) {
      return true;
    }
    return false;
  }

  private violation(policy: EvaluablePolicy, code: string, message: string): PolicyViolation {
    return { policyId: policy.id, policyName: policy.name, code, message };
  }
}

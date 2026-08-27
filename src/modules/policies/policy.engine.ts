import { Injectable } from '@nestjs/common';
import {
  EvaluablePolicy,
  PolicyConfiguration,
  PolicyEvaluationResult,
  PolicyViolation,
  TransactionIntent,
} from './policy.types';

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
      violations.push(...this.checkAmount(policy, config, intent, at));
      violations.push(...this.checkAssets(policy, config, intent));
      violations.push(...this.checkRecipients(policy, config, intent));
      violations.push(...this.checkPeriodicLimits(policy, config, intent));
      violations.push(...this.checkTimeWindow(policy, config, at));
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
          `Amount ${intent.amount} exceeds maximum ${effectiveMax}`,
        ),
      );
    }
    if (config.minAmount !== undefined && intent.amount < config.minAmount) {
      out.push(
        this.violation(
          policy,
          'MIN_AMOUNT_NOT_MET',
          `Amount ${intent.amount} is below minimum ${config.minAmount}`,
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
    const { startHour, endHour, days } = config.timeWindow;
    const hour = at.getUTCHours();
    const day = at.getUTCDay();
    const withinHours = hour >= startHour && hour < endHour;
    const withinDays = !days || days.includes(day);
    if (!withinHours || !withinDays) {
      return [
        this.violation(
          policy,
          'OUTSIDE_TIME_WINDOW',
          `Transaction attempted outside the allowed time window (${startHour}:00-${endHour}:00 UTC)`,
        ),
      ];
    }
    return [];
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

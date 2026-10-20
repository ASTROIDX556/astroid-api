import { Injectable } from '@nestjs/common';
import {
  AssetLimitConfiguration,
  AssetTransfer,
  EvaluablePolicy,
  PolicyConfiguration,
  PolicyEvaluationResult,
  PolicyViolation,
  SpendPeriods,
  TransactionIntent,
} from './policy.types';

/** Zero spend used when an asset has no recorded spend in any period. */
const NO_SPEND: SpendPeriods = { spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 };

/**
 * Upper-case asset code of an identifier, without the issuer. Never throws, so
 * the engine stays pure even when it is handed an unusual asset string.
 */
function assetKey(asset: string): string {
  const separator = asset.indexOf(':');
  return (separator === -1 ? asset : asset.slice(0, separator)).trim().toUpperCase();
}

/**
 * Pure, deterministic policy evaluation engine. Given a transaction intent and
 * the set of applicable policies, it returns every violation and whether human
 * approval is required. Contains NO I/O — it is trivially unit-testable and is
 * the heart of Astroid's "AI should never spend money freely" guarantee.
 *
 * ## Multi-asset evaluation
 *
 * An intent carries one or more {@link AssetTransfer} legs. A single-asset
 * intent is the degenerate case with exactly one leg, so the behaviour of
 * existing policies is unchanged. For every leg the engine applies:
 *
 *  - the per-asset limit overrides (`configuration.assetLimits[CODE]`) when the
 *    leg's asset has an entry, otherwise the policy-wide limits;
 *  - the asset allow/block lists;
 *  - the recipient lists (using the leg recipient when it has one);
 *  - the periodic limits, compared against the spend accumulated **for that
 *    asset**.
 *
 * Policy-wide rules that are not asset-specific (time window, emergency lock)
 * are evaluated once per policy so a multi-asset transfer never reports the
 * same policy-level violation twice.
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
    const legs = this.legsOf(intent);

    for (const policy of active) {
      const config = policy.configuration;
      for (const leg of legs) {
        violations.push(...this.checkAmount(policy, config, leg, intent, at));
        violations.push(...this.checkAssets(policy, config, leg));
        violations.push(...this.checkRecipients(policy, config, leg, intent));
        violations.push(...this.checkPeriodicLimits(policy, config, leg, intent));
      }
      violations.push(...this.checkTimeWindow(policy, config, at));
      violations.push(...this.checkEmergencyLock(policy, config));
      if (this.demandsApproval(config, legs)) {
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

  /** The legs of an intent: the explicit transfers, or the single legacy pair. */
  private legsOf(intent: TransactionIntent): AssetTransfer[] {
    if (intent.transfers && intent.transfers.length > 0) {
      return intent.transfers;
    }
    return [
      {
        asset: intent.asset,
        amount: intent.amount,
        recipientAddress: intent.recipientAddress,
      },
    ];
  }

  private appliesToAgent(policy: EvaluablePolicy, intent: TransactionIntent): boolean {
    // A policy with no agentId is organization-wide; otherwise it must match.
    return !policy.agentId || policy.agentId === intent.agentId;
  }

  /** Per-asset limit overrides for a leg, if the policy declares any. */
  private assetLimitsFor(
    config: PolicyConfiguration,
    leg: AssetTransfer,
  ): AssetLimitConfiguration | undefined {
    if (!config.assetLimits) {
      return undefined;
    }
    const key = assetKey(leg.asset);
    return config.assetLimits[key] ?? config.assetLimits[key.toLowerCase()];
  }

  /** The unit the limits of an evaluation are denominated in. */
  private unitFor(intent: TransactionIntent, leg: AssetTransfer): string {
    return intent.limitCurrency ?? assetKey(leg.asset);
  }

  private checkAmount(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    leg: AssetTransfer,
    intent: TransactionIntent,
    at: Date,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const assetLimits = this.assetLimitsFor(config, leg);
    const unit = this.unitFor(intent, leg);

    const effectiveMax = this.effectiveMaxAmount(policy, config, assetLimits, at);
    if (effectiveMax !== undefined && leg.amount > effectiveMax) {
      out.push(
        this.violation(
          policy,
          'MAX_AMOUNT_EXCEEDED',
          `Amount ${leg.amount} ${unit} exceeds maximum ${effectiveMax} ${unit}`,
          leg,
        ),
      );
    }

    const effectiveMin = assetLimits?.minAmount ?? config.minAmount;
    if (effectiveMin !== undefined && leg.amount < effectiveMin) {
      out.push(
        this.violation(
          policy,
          'MIN_AMOUNT_NOT_MET',
          `Amount ${leg.amount} ${unit} is below minimum ${effectiveMin} ${unit}`,
          leg,
        ),
      );
    }
    return out;
  }

  // Resolves the effective max amount for a policy at a point in time. When a
  // temporary override is active (overrideLimit set, overrideUntil in the
  // future), the overrideLimit wins. Otherwise the engine falls back to the
  // recorded originalLimit, or the configured maxAmount when no override was
  // ever captured. A per-asset override takes precedence over the policy-wide
  // limit, but never over an active spending override.
  private effectiveMaxAmount(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    assetLimits: AssetLimitConfiguration | undefined,
    at: Date,
  ): number | undefined {
    const overrideActive =
      policy.overrideLimit != null &&
      policy.overrideUntil != null &&
      at <= policy.overrideUntil;
    if (overrideActive) {
      return policy.overrideLimit ?? undefined;
    }
    return assetLimits?.maxAmount ?? policy.originalLimit ?? config.maxAmount;
  }

  private checkAssets(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    leg: AssetTransfer,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const code = assetKey(leg.asset);
    if (config.allowedAssets && !config.allowedAssets.some((asset) => asset.toUpperCase() === code)) {
      out.push(
        this.violation(policy, 'ASSET_NOT_ALLOWED', `Asset ${code} is not in the allow list`, leg),
      );
    }
    if (config.blockedAssets && config.blockedAssets.some((asset) => asset.toUpperCase() === code)) {
      out.push(this.violation(policy, 'ASSET_BLOCKED', `Asset ${code} is blocked`, leg));
    }
    return out;
  }

  private checkRecipients(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    leg: AssetTransfer,
    intent: TransactionIntent,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const recipient = leg.recipientAddress ?? intent.recipientAddress;
    if (config.allowedRecipients && !config.allowedRecipients.includes(recipient)) {
      out.push(
        this.violation(
          policy,
          'RECIPIENT_NOT_ALLOWED',
          `Recipient ${recipient} is not in the allow list`,
          leg,
        ),
      );
    }
    if (config.blockedRecipients && config.blockedRecipients.includes(recipient)) {
      out.push(this.violation(policy, 'RECIPIENT_BLOCKED', `Recipient ${recipient} is blocked`, leg));
    }
    return out;
  }

  private checkPeriodicLimits(
    policy: EvaluablePolicy,
    config: PolicyConfiguration,
    leg: AssetTransfer,
    intent: TransactionIntent,
  ): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    const assetLimits = this.assetLimitsFor(config, leg);
    const unit = this.unitFor(intent, leg);
    const spent = this.spendFor(intent, leg);

    const checks: Array<[number | undefined, number, string, string]> = [
      [assetLimits?.dailyLimit ?? config.dailyLimit, spent.spentToday, 'DAILY_LIMIT_EXCEEDED', 'daily'],
      [
        assetLimits?.weeklyLimit ?? config.weeklyLimit,
        spent.spentThisWeek,
        'WEEKLY_LIMIT_EXCEEDED',
        'weekly',
      ],
      [
        assetLimits?.monthlyLimit ?? config.monthlyLimit,
        spent.spentThisMonth,
        'MONTHLY_LIMIT_EXCEEDED',
        'monthly',
      ],
    ];
    for (const [limit, spentInPeriod, code, label] of checks) {
      if (limit === undefined) {
        continue;
      }
      const projected = spentInPeriod + leg.amount;
      if (projected > limit) {
        out.push(
          this.violation(
            policy,
            code,
            `Projected ${label} spend ${projected} ${unit} exceeds limit ${limit} ${unit}`,
            leg,
          ),
        );
      }
    }
    return out;
  }

  /** Spend already accumulated for the asset of a leg. */
  private spendFor(intent: TransactionIntent, leg: AssetTransfer): SpendPeriods {
    if (intent.spentByAsset) {
      const direct = intent.spentByAsset[leg.asset];
      if (direct) return direct;
      const byCode = intent.spentByAsset[assetKey(leg.asset)];
      if (byCode) return byCode;
      return NO_SPEND;
    }
    // Without per-asset aggregates the flat period fields describe the primary
    // asset of the intent; other assets of a multi-asset transfer have not
    // spent anything yet.
    if (assetKey(leg.asset) !== assetKey(intent.asset)) {
      return NO_SPEND;
    }
    return {
      spentToday: intent.spentToday ?? 0,
      spentThisWeek: intent.spentThisWeek ?? 0,
      spentThisMonth: intent.spentThisMonth ?? 0,
    };
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

  private demandsApproval(
    config: PolicyConfiguration,
    legs: AssetTransfer[],
  ): boolean {
    if (config.requiresApproval) {
      return true;
    }
    if (config.approvalThreshold === undefined) {
      return false;
    }
    return legs.some((leg) => leg.amount >= config.approvalThreshold!);
  }

  private violation(
    policy: EvaluablePolicy,
    code: string,
    message: string,
    leg?: AssetTransfer,
  ): PolicyViolation {
    const violation: PolicyViolation = {
      policyId: policy.id,
      policyName: policy.name,
      code,
      message,
    };
    if (leg) {
      violation.asset = assetKey(leg.asset);
    }
    return violation;
  }
}

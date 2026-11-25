import { Injectable } from '@nestjs/common';
import { RiskBand } from '@prisma/client';
import { clamp } from '../../utils/decimal.util';
import {
  DEFAULT_RISK_CONFIG,
  RiskAssessment,
  RiskConfig,
  RiskFactorsInput,
  RiskRuleContext,
  RiskRule,
  RiskFactorScore,
} from './risk.types';
import {
  AmountRule,
  AmountAnomalyRule,
  RecipientRule,
  RecipientReputationRule,
  VelocityRule,
  WalletAgeRule,
  PolicyViolationRule,
  SuspiciousTimingRule,
} from './rules';

/**
 * Pure risk-scoring engine. Produces a 0-100 composite score from weighted
 * pluggable rules and maps it to a band:
 *   0-20 Low, 21-50 Medium, 51-80 High, 81-100 Critical.
 *
 * Rules are pure functions — each takes a {@link RiskRuleContext} and returns
 * a partial {@link RiskFactorScore}. New heuristics can be added by registering
 * additional rules without modifying the engine.
 *
 * Thresholds (saturation points, band boundaries) are driven by
 * {@link RiskConfig}, which can be overridden per agent or organization.
 */
@Injectable()
export class RiskEngine {
  /** Built-in rules registered by default. */
  private readonly defaultRules: RiskRule[] = [
    AmountRule,
    AmountAnomalyRule,
    RecipientRule,
    RecipientReputationRule,
    VelocityRule,
    WalletAgeRule,
    PolicyViolationRule,
    SuspiciousTimingRule,
  ];

  /**
   * Run the full assessment using the provided (or default) rules and config.
   *
   * @param input    Transaction risk factors
   * @param config   Optional per-org/agent configuration overrides
   * @param rules    Optional additional or replacement rules
   */
  assess(
    input: RiskFactorsInput,
    config?: Partial<RiskConfig>,
    rules?: RiskRule[],
  ): RiskAssessment {
    const effectiveConfig = this.mergeConfig(config);
    const effectiveRules = rules ?? this.defaultRules;
    const context: RiskRuleContext = { input, config: effectiveConfig };

    const factors = this.normalizeFactors(
      effectiveRules.map((rule) => rule.evaluate(context)),
    );

    const score = Math.round(
      clamp(
        factors.reduce((sum, f) => sum + f.contribution, 0),
        0,
        100,
      ),
    );
    this.normalizeContributions(factors, score);
    const band = this.toBand(score, effectiveConfig);
    return {
      score,
      band,
      factors,
      // Thresholds are explicit so a high-risk transaction is always routed to
      // a human: at or above the review threshold it needs an approval, at or
      // above the block threshold it can never auto-execute.
      canAutoExecute: score < effectiveConfig.blockThreshold,
      requiresApproval: score >= effectiveConfig.reviewThreshold,
    };
  }

  private normalizeFactors(factors: RiskFactorScore[]): RiskFactorScore[] {
    const order = [
      'amount',
      'amountAnomaly',
      'unknownRecipient',
      'destinationReputation',
      'velocity',
      'walletAge',
      'policyViolations',
      'suspiciousTiming',
    ];
    const index = new Map(order.map((code, i) => [code, i]));

    return factors
      .map((factor) => {
        const code = factor.code ?? (factor.factor as RiskFactorScore['code']);
        return {
          ...factor,
          code,
          description: factor.description ?? factor.detail,
        };
      })
      .sort((a, b) => {
        const ai = index.get(a.code ?? '') ?? order.length;
        const bi = index.get(b.code ?? '') ?? order.length;
        return ai === bi ? a.factor.localeCompare(b.factor) : ai - bi;
      });
  }

  /** Round the breakdown without changing the existing rounded scalar score. */
  private normalizeContributions(factors: RiskFactorScore[], score: number): void {
    for (const factor of factors) {
      factor.contribution = Math.round((factor.contribution + Number.EPSILON) * 100) / 100;
    }

    let remainingCents = Math.round(
      (score - factors.reduce((sum, factor) => sum + factor.contribution, 0)) * 100,
    );
    for (const factor of factors) {
      if (remainingCents === 0) break;
      const currentCents = Math.round(factor.contribution * 100);
      const adjustment = remainingCents > 0
        ? Math.min(remainingCents, Math.max(Math.round(factor.weight * 100) - currentCents, 0))
        : Math.max(remainingCents, -currentCents);
      factor.contribution = (currentCents + adjustment) / 100;
      remainingCents -= adjustment;
    }

    if (remainingCents !== 0 && factors.length > 0) {
      factors[0].contribution += remainingCents / 100;
    }
  }

  /**
   * Maps a numeric score to its band, using optional custom thresholds from config.
   */
  toBand(score: number, config?: Partial<RiskConfig>): RiskBand {
    const t = config?.bandThresholds;
    const lowMax = t?.lowMax ?? 20;
    const medMax = t?.medMax ?? 50;
    const highMax = t?.highMax ?? 80;

    if (score <= lowMax) return RiskBand.LOW;
    if (score <= medMax) return RiskBand.MEDIUM;
    if (score <= highMax) return RiskBand.HIGH;
    return RiskBand.CRITICAL;
  }

  /** Merges partial overrides onto the default config. */
  private mergeConfig(overrides?: Partial<RiskConfig>): RiskConfig {
    if (!overrides) return { ...DEFAULT_RISK_CONFIG };
    return {
      ...DEFAULT_RISK_CONFIG,
      ...overrides,
      weights: { ...DEFAULT_RISK_CONFIG.weights, ...overrides.weights },
      bandThresholds: overrides.bandThresholds
        ? { ...DEFAULT_RISK_CONFIG.bandThresholds, ...overrides.bandThresholds }
        : DEFAULT_RISK_CONFIG.bandThresholds,
    };
  }
}

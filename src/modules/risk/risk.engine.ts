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
} from './risk.types';
import {
  AmountRule,
  RecipientRule,
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
    RecipientRule,
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

    const factors = effectiveRules.map((rule) => rule.evaluate(context));

    const score = Math.round(
      clamp(
        factors.reduce((sum, f) => sum + f.contribution, 0),
        0,
        100,
      ),
    );
    const band = this.toBand(score, effectiveConfig);
    return { score, band, factors, canAutoExecute: band !== RiskBand.CRITICAL };
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

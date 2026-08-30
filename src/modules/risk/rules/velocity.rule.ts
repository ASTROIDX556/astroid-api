import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Evaluates recent transaction count against a configurable saturation threshold.
 * High velocity (many recent transactions) increases risk.
 */
export const VelocityRule: RiskRule = {
  name: 'velocity',
  defaultWeight: RISK_WEIGHTS.velocity,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const ratio = clamp(input.recentTransactionCount / config.velocitySaturation, 0, 1);
    const weight = config.weights?.velocity ?? VelocityRule.defaultWeight;
    return {
      factor: 'velocity',
      weight,
      contribution: ratio * weight,
      detail: `${input.recentTransactionCount} recent transactions`,
    };
  },
};

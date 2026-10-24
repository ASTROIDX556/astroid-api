import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Evaluates recent transaction activity against configurable saturation
 * thresholds. Both the number of transactions and the total value moved in the
 * window are considered, and the stronger of the two drives the signal: a
 * burst of large payments is as suspicious as a burst of small ones.
 */
export const VelocityRule: RiskRule = {
  name: 'velocity',
  defaultWeight: RISK_WEIGHTS.velocity,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const countRatio = clamp(input.recentTransactionCount / config.velocitySaturation, 0, 1);
    const amountRatio =
      input.recentTransactionAmount === undefined
        ? 0
        : clamp(input.recentTransactionAmount / config.velocityAmountSaturation, 0, 1);
    const ratio = Math.max(countRatio, amountRatio);
    const weight = config.weights?.velocity ?? VelocityRule.defaultWeight;
    return {
      factor: 'velocity',
      weight,
      contribution: ratio * weight,
      detail: `${input.recentTransactionCount} recent transactions, ${input.recentTransactionAmount ?? 0} total value`,
    };
  },
};

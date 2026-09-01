import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Evaluates the transaction amount against a configurable saturation threshold.
 * Larger amounts contribute more risk.
 */
export const AmountRule: RiskRule = {
  name: 'amount',
  defaultWeight: RISK_WEIGHTS.amount,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const ratio = clamp(input.amount / config.amountSaturation, 0, 1);
    const weight = config.weights?.amount ?? AmountRule.defaultWeight;
    return {
      factor: 'amount',
      weight,
      contribution: ratio * weight,
      detail: `Amount ${input.amount}`,
    };
  },
};

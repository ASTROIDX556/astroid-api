import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Detects an amount that is out of character for the sending wallet.
 *
 * The signal compares the transfer against the wallet's own historical average
 * amount: an amount at or below the average is normal, and the risk grows
 * linearly until the transfer reaches `amountAnomalySaturation` times the
 * average, where the signal saturates.
 *
 * Without a historical baseline (a brand new wallet) there is nothing to
 * compare against, so the rule abstains and contributes nothing.
 */
export const AmountAnomalyRule: RiskRule = {
  name: 'amountAnomaly',
  defaultWeight: RISK_WEIGHTS.amountAnomaly,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const weight = config.weights?.amountAnomaly ?? AmountAnomalyRule.defaultWeight;
    const baseline = input.amountBaseline;

    if (baseline === undefined || baseline <= 0) {
      return {
        factor: 'amountAnomaly',
        weight,
        contribution: 0,
        detail: 'No historical amount baseline for this wallet',
      };
    }

    const ratio = input.amount / baseline;
    if (ratio <= 1) {
      return {
        factor: 'amountAnomaly',
        weight,
        contribution: 0,
        detail: `Amount is ${ratio.toFixed(2)}x the historical average`,
      };
    }

    const saturation = Math.max(config.amountAnomalySaturation, 1.000_001);
    const risk = clamp((ratio - 1) / (saturation - 1), 0, 1) * 100;

    return {
      factor: 'amountAnomaly',
      weight,
      contribution: (risk / 100) * weight,
      detail: `Amount is ${ratio.toFixed(2)}x the historical average`,
    };
  },
};

import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Evaluates policy violations against a configurable saturation threshold.
 * Each violation adds risk, saturating at the configured limit.
 */
export const PolicyViolationRule: RiskRule = {
  name: 'policyViolations',
  defaultWeight: RISK_WEIGHTS.policyViolations,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const ratio = clamp(input.policyViolations / config.policyViolationSaturation, 0, 1);
    const weight = config.weights?.policyViolations ?? PolicyViolationRule.defaultWeight;
    return {
      factor: 'policyViolations',
      weight,
      contribution: ratio * weight,
      detail: `${input.policyViolations} policy violation(s)`,
    };
  },
};

import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';

/**
 * Flags transactions attempted during a configurable overnight window (UTC).
 * Suspicious timing adds a flat risk contribution.
 */
export const SuspiciousTimingRule: RiskRule = {
  name: 'suspiciousTiming',
  defaultWeight: RISK_WEIGHTS.suspiciousTiming,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const weight = config.weights?.suspiciousTiming ?? SuspiciousTimingRule.defaultWeight;
    const hour = input.hourUtc;
    const suspicious =
      hour !== undefined && hour >= config.suspiciousHourStart && hour < config.suspiciousHourEnd;
    return {
      factor: 'suspiciousTiming',
      weight,
      contribution: suspicious ? weight : 0,
      detail: suspicious ? 'Overnight transaction' : 'Normal hours',
    };
  },
};

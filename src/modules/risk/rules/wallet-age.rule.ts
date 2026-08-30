import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Evaluates wallet age against a configurable seasoned threshold.
 * Newer wallets carry more risk; older wallets are considered seasoned.
 */
export const WalletAgeRule: RiskRule = {
  name: 'walletAge',
  defaultWeight: RISK_WEIGHTS.walletAge,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const seasoned = clamp(input.walletAgeDays / config.walletSeasonedDays, 0, 1);
    const weight = config.weights?.walletAge ?? WalletAgeRule.defaultWeight;
    return {
      factor: 'walletAge',
      weight,
      contribution: (1 - seasoned) * weight,
      detail: `Wallet age ${input.walletAgeDays} day(s)`,
    };
  },
};

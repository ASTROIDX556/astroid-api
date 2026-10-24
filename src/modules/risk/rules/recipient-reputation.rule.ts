import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';
import { clamp } from '../../../utils/decimal.util';

/**
 * Scores the reputation of the destination address from the organization's own
 * payment history with it.
 *
 * Two components drive the signal:
 *  - the failure rate of the prior payments (a destination that repeatedly
 *    failed to settle is less trustworthy), and
 *  - the depth of that history (a single past payment proves little).
 *
 * A destination the organization has never paid carries no history at all; the
 * unknown-recipient rule is responsible for that case, so this rule abstains
 * and contributes nothing.
 */
export const RecipientReputationRule: RiskRule = {
  name: 'destinationReputation',
  defaultWeight: RISK_WEIGHTS.destinationReputation,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const weight = config.weights?.destinationReputation ?? RecipientReputationRule.defaultWeight;
    const total = input.destinationPaymentCount ?? 0;
    const failed = input.destinationFailureCount ?? 0;

    if (total <= 0) {
      return {
        factor: 'destinationReputation',
        weight,
        contribution: 0,
        detail: 'No payment history for this destination',
      };
    }

    const failureRate = clamp(failed / total, 0, 1);
    const confidence = clamp(total / config.reputationHistoryDepth, 0, 1);
    const shallowness = 1 - confidence;
    const risk =
      100 *
      (config.reputationFailureWeight * failureRate +
        config.reputationShallowWeight * shallowness);

    return {
      factor: 'destinationReputation',
      weight,
      contribution: (clamp(risk, 0, 100) / 100) * weight,
      detail: `${total} prior payment(s) to this destination, ${failed} failed`,
    };
  },
};

import { RiskFactorScore, RiskRuleContext, RiskRule, RISK_WEIGHTS } from '../risk.types';

/**
 * Flags transactions to recipients the organization has never paid before.
 * Unknown recipients carry a flat risk contribution.
 */
export const RecipientRule: RiskRule = {
  name: 'unknownRecipient',
  defaultWeight: RISK_WEIGHTS.unknownRecipient,

  evaluate({ input, config }: RiskRuleContext): RiskFactorScore {
    const weight = config.weights?.unknownRecipient ?? RecipientRule.defaultWeight;
    return {
      factor: 'unknownRecipient',
      weight,
      contribution: input.knownRecipient ? 0 : weight,
      detail: input.knownRecipient ? 'Known recipient' : 'Recipient never paid before',
    };
  },
};

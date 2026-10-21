import { RiskBand } from '@prisma/client';

/** Inputs to the risk engine — all optional except amount. */
export interface RiskFactorsInput {
  amount: number;
  asset: string;
  /** Has this recipient been paid before by the org? */
  knownRecipient: boolean;
  /** Number of transactions by this agent/wallet in the recent window. */
  recentTransactionCount: number;
  /** Age of the wallet in days. Newer wallets are riskier. */
  walletAgeDays: number;
  /** Count of policy violations detected for this intent. */
  policyViolations: number;
  /** Hour-of-day (UTC) the transaction is attempted, for suspicious timing. */
  hourUtc?: number;
  /** Total value moved by the wallet inside the velocity window. */
  recentTransactionAmount?: number;
  /** Prior payments to the destination address (successful + failed). */
  destinationPaymentCount?: number;
  /** Prior failed payments to the destination address. */
  destinationFailureCount?: number;
  /** Average amount of the wallet's recent transactions (anomaly baseline). */
  amountBaseline?: number;
}

export interface RiskFactorScore {
  factor: string;
  weight: number;
  contribution: number;
  detail: string;
}

export interface RiskAssessment {
  score: number;
  band: RiskBand;
  factors: RiskFactorScore[];
  /** Transactions at or above the block threshold never auto-execute. */
  canAutoExecute: boolean;
  /** Transactions at or above the review threshold need a human approval. */
  requiresApproval: boolean;
}

/**
 * Weight each factor contributes to the 0-100 composite score.
 *
 * The three aggregator signals mandated for incoming agent transactions —
 * velocity, destination reputation and amount anomaly — carry 40% of the
 * composite; the remaining 60% covers the absolute amount, the unknown
 * recipient, the wallet age, the policy violations and the transaction
 * timing. The weights always sum to 100 so a fully saturated assessment
 * reaches exactly 100.
 */
export const RISK_WEIGHTS = {
  /** Absolute size of the transfer against a static saturation point. */
  amount: 30,
  /** Transfer size relative to the wallet's own historical average. */
  amountAnomaly: 10,
  /** Destination the organization has never paid before. */
  unknownRecipient: 15,
  /** Failure rate and depth of the payment history with the destination. */
  destinationReputation: 10,
  /** Transaction count and value moved in the recent window. */
  velocity: 20,
  /** Age of the sending wallet. */
  walletAge: 10,
  /** Policy violations detected for this intent. */
  policyViolations: 5,
  /** Transactions attempted during the suspicious hours. */
  suspiciousTiming: 5,
} as const;

// ── Pluggable rule system ─────────────────────────────────────────────────

/** Context passed to every risk rule during evaluation. */
export interface RiskRuleContext {
  input: RiskFactorsInput;
  config: RiskConfig;
}

/** A single pluggable risk rule — a pure function returning a partial score. */
export interface RiskRule {
  /** Unique name for this rule (e.g. 'amount', 'velocity'). */
  readonly name: string;
  /** Weight this rule contributes to the composite score (default from RISK_WEIGHTS). */
  readonly defaultWeight: number;
  /** Evaluate the transaction context and return a factor score. */
  evaluate(context: RiskRuleContext): RiskFactorScore;
}

/** Configurable thresholds — stored per agent/org or falling back to defaults. */
export interface RiskConfig {
  /** Amount at which the amount rule saturates to full weight. */
  amountSaturation: number;
  /** Recent transaction count at which velocity saturates. */
  velocitySaturation: number;
  /** Recent transaction value at which the velocity rule saturates. */
  velocityAmountSaturation: number;
  /** Wallet age (days) beyond which the wallet is considered fully seasoned. */
  walletSeasonedDays: number;
  /** Number of policy violations at which the policy rule saturates. */
  policyViolationSaturation: number;
  /** Hour range considered suspicious (start inclusive, end exclusive). */
  suspiciousHourStart: number;
  /** Hour range considered suspicious (end exclusive). */
  suspiciousHourEnd: number;
  /** Prior payments to a destination that give a full reputation history. */
  reputationHistoryDepth: number;
  /** Share of the reputation risk driven by the failure rate (0-1). */
  reputationFailureWeight: number;
  /** Share of the reputation risk driven by a shallow history (0-1). */
  reputationShallowWeight: number;
  /** Multiple of the historical average amount that saturates the anomaly signal. */
  amountAnomalySaturation: number;
  /** Score at or above which a transaction is routed to human review. */
  reviewThreshold: number;
  /** Score at or above which a transaction can never auto-execute. */
  blockThreshold: number;
  /** Override individual rule weights. Keys are rule names. */
  weights?: Partial<Record<string, number>>;
  /** Custom band thresholds: score <= lowMax → LOW, <= medMax → MEDIUM, <= highMax → HIGH, else CRITICAL. */
  bandThresholds?: { lowMax: number; medMax: number; highMax: number };
}

/** Default risk configuration used when no org/agent overrides exist. */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  amountSaturation: 10_000,
  velocitySaturation: 20,
  velocityAmountSaturation: 20_000,
  walletSeasonedDays: 90,
  policyViolationSaturation: 2,
  suspiciousHourStart: 0,
  suspiciousHourEnd: 5,
  reputationHistoryDepth: 5,
  reputationFailureWeight: 0.5,
  reputationShallowWeight: 0.5,
  amountAnomalySaturation: 5,
  reviewThreshold: 51,
  blockThreshold: 81,
};

// ── Risk aggregator ───────────────────────────────────────────────────────

/** Context the aggregator needs to build its risk signals. */
export interface RiskAggregationInput {
  /** Organization the transaction belongs to. */
  organizationId: string;
  /** Wallet sending the funds — used for the velocity and anomaly signals. */
  walletId: string;
  /** Destination address — used for the reputation signal. */
  recipientAddress: string;
  /** Amount being transferred. */
  amount: number;
  /** Asset being transferred. */
  asset: string;
  /** Age of the sending wallet in days. */
  walletAgeDays: number;
  /** Policy violations detected for this intent. */
  policyViolations?: number;
  /** Hour-of-day (UTC) the transaction is attempted. */
  hourUtc?: number;
  /** Hours of history used for the velocity window (default 24). */
  velocityWindowHours?: number;
  /** Days of history used for the amount baseline (default 90). */
  amountBaselineWindowDays?: number;
}

/** Raw signals the aggregator derived from the transaction history. */
export interface RiskSignals {
  /** Transactions sent by the wallet inside the velocity window. */
  recentTransactionCount: number;
  /** Total value moved by the wallet inside the velocity window. */
  recentTransactionAmount: number;
  /** Successful payments the organization made to the destination. */
  destinationSuccessfulPayments: number;
  /** Failed payments the organization made to the destination. */
  destinationFailedPayments: number;
  /** Average amount of the wallet's recent transactions (null without history). */
  amountBaseline: number | null;
}

/** Composite risk assessment produced by the aggregator. */
export interface RiskAggregation extends RiskAssessment {
  /** True when the score reached the review threshold (human review). */
  requiresApproval: boolean;
  /** The signals the composite score was derived from. */
  signals: RiskSignals;
}

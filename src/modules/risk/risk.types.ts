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
  /** Critical transactions can never auto-execute. */
  canAutoExecute: boolean;
}

/** Weight each factor contributes to the 0-100 composite score. */
export const RISK_WEIGHTS = {
  amount: 30,
  unknownRecipient: 20,
  velocity: 15,
  walletAge: 15,
  policyViolations: 15,
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
  /** Wallet age (days) beyond which the wallet is considered fully seasoned. */
  walletSeasonedDays: number;
  /** Number of policy violations at which the policy rule saturates. */
  policyViolationSaturation: number;
  /** Hour range considered suspicious (start inclusive, end exclusive). */
  suspiciousHourStart: number;
  /** Hour range considered suspicious (end exclusive). */
  suspiciousHourEnd: number;
  /** Override individual rule weights. Keys are rule names. */
  weights?: Partial<Record<string, number>>;
  /** Custom band thresholds: score <= lowMax → LOW, <= medMax → MEDIUM, <= highMax → HIGH, else CRITICAL. */
  bandThresholds?: { lowMax: number; medMax: number; highMax: number };
}

/** Default risk configuration used when no org/agent overrides exist. */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  amountSaturation: 10_000,
  velocitySaturation: 20,
  walletSeasonedDays: 90,
  policyViolationSaturation: 2,
  suspiciousHourStart: 0,
  suspiciousHourEnd: 5,
};

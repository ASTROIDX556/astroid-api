import { registerAs } from '@nestjs/config';
import { validateEnv, walletReconciliationEnvSchema } from './env.validation';

/**
 * Scheduled Stellar wallet reconciliation.
 *
 * The repeatable BullMQ job fetches the native balance of every ACTIVE wallet
 * from Horizon, persists the snapshot and emits a drift event when the
 * difference exceeds `driftThreshold`. All network details come from the
 * existing `stellar` configuration slice (`STELLAR_HORIZON_URL`,
 * `STELLAR_NETWORK`), so there is a single source of truth for the network.
 */
export type WalletReconciliationConfig = {
  /** Whether the repeatable job is registered at boot. */
  enabled: boolean;
  /** Interval between runs, in milliseconds. */
  intervalMs: number;
  /** Wallets reconciled in parallel within one run. */
  concurrency: number;
  /** Native balance delta (in XLM) above which a drift event is emitted. */
  driftThreshold: number;
};

/** Documented defaults, used when the configuration slice is unavailable. */
export const DEFAULT_WALLET_RECONCILIATION_CONFIG: WalletReconciliationConfig = {
  enabled: true,
  intervalMs: 15 * 60 * 1000,
  concurrency: 5,
  driftThreshold: 0.0000001,
};

export const walletReconciliationConfig = registerAs(
  'walletReconciliation',
  (): WalletReconciliationConfig => {
    const env = validateEnv(walletReconciliationEnvSchema, process.env);
    return {
      enabled: env.WALLET_RECONCILIATION_ENABLED,
      intervalMs: env.WALLET_RECONCILIATION_INTERVAL_MINUTES * 60 * 1000,
      concurrency: env.WALLET_RECONCILIATION_CONCURRENCY,
      driftThreshold: env.WALLET_BALANCE_DRIFT_THRESHOLD,
    };
  },
);

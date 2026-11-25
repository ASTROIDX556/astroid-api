import { registerAs } from '@nestjs/config';
import { validateEnv, budgetRolloverEnvSchema } from './env.validation';

/**
 * Scheduled close/reopen of fixed budget periods.
 *
 * Cadence, page size and the per-run page cap are all configurable; the safe
 * defaults are one minute, 100 budgets per page and 20 pages per run. The
 * carry-over *rule* itself is stored on each budget (see
 * `BudgetCarryOverRule`), defaulting to NONE so existing budgets are unchanged.
 */
export type BudgetRolloverConfig = {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxBatches: number;
};

export const DEFAULT_BUDGET_ROLLOVER_CONFIG: BudgetRolloverConfig = {
  enabled: true,
  intervalMs: 60 * 1000,
  batchSize: 100,
  maxBatches: 20,
};

export const budgetRolloverConfig = registerAs(
  'budgetRollover',
  (): BudgetRolloverConfig => {
    const env = validateEnv(budgetRolloverEnvSchema, process.env);
    return {
      enabled: env.BUDGET_ROLLOVER_ENABLED,
      intervalMs: env.BUDGET_ROLLOVER_INTERVAL_MINUTES * 60 * 1000,
      batchSize: env.BUDGET_ROLLOVER_BATCH_SIZE,
      maxBatches: env.BUDGET_ROLLOVER_MAX_BATCHES,
    };
  },
);

import { registerAs } from '@nestjs/config';
import { budgetAlertEnvSchema, validateEnv } from './env.validation';

/**
 * Budget threshold alerting configuration.
 *
 * Thresholds are percentages of a budget's limit. A spend that crosses a
 * threshold emits a `budget.threshold_reached` domain event exactly once per
 * budget period; the notification consumer turns that event into in-app
 * notification records.
 */
export type BudgetAlertConfig = {
  /** Percentage thresholds, sorted ascending, applied to every budget. */
  thresholds: number[];
};

/** Documented defaults, mirrored by `budgetAlertEnvSchema`. */
export const DEFAULT_BUDGET_ALERT_CONFIG: BudgetAlertConfig = {
  thresholds: [80, 100],
};

export const budgetAlertConfig = registerAs('budgetAlert', (): BudgetAlertConfig => {
  const env = validateEnv(budgetAlertEnvSchema, process.env);
  return {
    thresholds: env.BUDGET_ALERT_THRESHOLDS,
  };
});

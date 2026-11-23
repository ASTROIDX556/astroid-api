import { registerAs } from '@nestjs/config';
import { approvalEnvSchema, validateEnv } from './env.validation';

export type ApprovalConfig = {
  ttlHours: number;
  sweepIntervalMs: number;
  sweepBatchSize: number;
};

export const approvalConfig = registerAs('approval', (): ApprovalConfig => {
  const env = validateEnv(approvalEnvSchema, process.env);
  return {
    ttlHours: env.APPROVAL_TTL_HOURS,
    sweepIntervalMs: env.APPROVAL_SWEEP_INTERVAL_MS,
    sweepBatchSize: env.APPROVAL_SWEEP_BATCH_SIZE,
  };
});

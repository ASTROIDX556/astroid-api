import { registerAs } from '@nestjs/config';
import { auditEnvSchema, validateEnv } from './env.validation';

export type AuditConfig = {
  /** Whether the scheduled archival job runs. */
  archiveEnabled: boolean;
  /** Age (in days) at which audit records become eligible for archival. */
  archiveRetentionDays: number;
  /** Maximum number of records archived per organization and batch. */
  archiveBatchSize: number;
  /** Maximum number of batches processed in a single archival run. */
  archiveMaxBatches: number;
  /** Hard-delete retention applied by the audit cleanup job (days). */
  retentionDays: number;
};

export const auditConfig = registerAs('audit', (): AuditConfig => {
  const env = validateEnv(auditEnvSchema, process.env);
  return {
    archiveEnabled: env.AUDIT_ARCHIVE_ENABLED,
    archiveRetentionDays: env.AUDIT_ARCHIVE_RETENTION_DAYS,
    archiveBatchSize: env.AUDIT_ARCHIVE_BATCH_SIZE,
    archiveMaxBatches: env.AUDIT_ARCHIVE_MAX_BATCHES,
    retentionDays: env.AUDIT_RETENTION_DAYS,
  };
});

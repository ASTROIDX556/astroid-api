import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  AuditArchiveRepository,
  AuditArchiveSummary,
  ArchivableAuditLog,
} from './audit-archive.repository';
import { MetricsService } from '../metrics/metrics.service';
import { AuditConfig } from '../../config/audit.config';
import { NotFoundException } from '../../common/exceptions/domain.exception';

/** Result of one archival run. */
export interface AuditArchiveRunResult {
  /** The retention cutoff the run applied. */
  cutoff: Date;
  /** Number of batches that were archived. */
  batches: number;
  /** Number of audit records that were archived. */
  archivedRecords: number;
  /** Number of audit records that were removed from the active table. */
  deletedRecords: number;
  /** Wall-clock duration of the run (ms). */
  durationMs: number;
}

/** Milliseconds in a day, used to turn the retention window into a cutoff. */
const DAY_MS = 86_400_000;

/**
 * Scheduled archival of expired audit records.
 *
 * The job moves audit rows that are older than the configured retention
 * period out of the actively queried `audit_logs` table into a compressed
 * archive (`audit_log_archives`). The archive keeps the full row content plus
 * a checksum, so the audit history is preserved while the hot table — and
 * every query against it — stays small.
 *
 * Safety properties:
 *
 *  - **Bounded work.** Records are selected in batches of at most
 *    `AUDIT_ARCHIVE_BATCH_SIZE` rows and at most `AUDIT_ARCHIVE_MAX_BATCHES`
 *    batches are processed per run, so the job never locks the table for long.
 *  - **Nothing is deleted before it is archived.** The compressed batch is
 *    written and read back (checksum + record count verified) *before* the
 *    source rows are removed. A failure in between leaves the records in place.
 *  - **Idempotent.** The batch id is derived from the archived row ids, so a
 *    retried run reuses the existing archive instead of writing a second copy,
 *    and the deletion of already-removed rows is a no-op.
 *  - **Chain preserving.** The oldest rows are archived first, so the archived
 *    set of an organization is always a prefix of its hash chain. The hash of
 *    the last archived entry is stored with the batch and anchors the live
 *    rows, which keeps `GET /audit/integrity/verify` meaningful.
 */
@Injectable()
export class AuditArchiveService {
  private readonly logger = new Logger(AuditArchiveService.name);

  constructor(
    private readonly repository: AuditArchiveRepository,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /** The resolved archival configuration. */
  private get settings(): AuditConfig {
    return (
      this.config.get<AuditConfig>('audit') ?? {
        archiveEnabled: true,
        archiveRetentionDays: 30,
        archiveBatchSize: 500,
        archiveMaxBatches: 20,
        retentionDays: 90,
      }
    );
  }

  /** The age (in days) at which audit records become eligible for archival. */
  get retentionDays(): number {
    return this.settings.archiveRetentionDays;
  }

  /** The newest timestamp that is still eligible for archival. */
  retentionCutoff(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.retentionDays * DAY_MS);
  }

  /**
   * Runs one archival pass: selects the expired records in bounded batches,
   * archives them and removes them from the active table.
   *
   * @throws when a batch cannot be archived or verified. The already archived
   * batches stay archived, and the queue retries the run.
   */
  async archive(now: Date = new Date()): Promise<AuditArchiveRunResult> {
    if (!this.settings.archiveEnabled) {
      this.logger.log('Audit archival is disabled; no records were archived');
      return {
        cutoff: this.retentionCutoff(now),
        batches: 0,
        archivedRecords: 0,
        deletedRecords: 0,
        durationMs: 0,
      };
    }

    const cutoff = this.retentionCutoff(now);
    const batchSize = this.settings.archiveBatchSize;
    const maxBatches = this.settings.archiveMaxBatches;
    const startedAt = Date.now();

    let batches = 0;
    let archivedRecords = 0;
    let deletedRecords = 0;

    this.logger.log(
      `Starting audit archival run (cutoff ${cutoff.toISOString()}, batch size ${batchSize}, max batches ${maxBatches})`,
    );

    try {
      while (batches < maxBatches) {
        const records = await this.repository.findArchivable(cutoff, batchSize);
        if (records.length === 0) {
          break;
        }

        const groups = groupByOrganization(records);
        let deletedInIteration = 0;

        for (const [organizationId, organizationRecords] of groups) {
          if (batches >= maxBatches) {
            break;
          }
          const result = await this.archiveBatch(organizationId, organizationRecords, cutoff);
          batches += 1;
          archivedRecords += result.archivedRecords;
          deletedRecords += result.deletedRecords;
          deletedInIteration += result.deletedRecords;
        }

        // Nothing could be removed: stop instead of selecting the same rows again.
        if (deletedInIteration === 0) {
          break;
        }
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.metrics.recordAuditArchive(archivedRecords, 'failed');
      this.logger.error(
        `Audit archival failed after ${archivedRecords} archived record(s) in ${batches} batch(es) (${durationMs}ms): ${(error as Error).message}`,
      );
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    this.metrics.recordAuditArchive(archivedRecords, 'archived');
    this.metrics.recordAuditArchive(deletedRecords, 'deleted');

    const result: AuditArchiveRunResult = {
      cutoff,
      batches,
      archivedRecords,
      deletedRecords,
      durationMs,
    };

    this.logger.log(
      `Audit archival completed: ${archivedRecords} records archived and removed from the active table in ${batches} batch(es) in ${durationMs}ms`,
    );
    return result;
  }

  // ── read path ──────────────────────────────────────────────────────────

  /**
   * Lists the archive batches of an organization, newest first.
   *
   * The compressed payloads are not loaded: a listing only describes the
   * batches so a caller can pick one and fetch its records.
   */
  async listArchives(organizationId: string, limit = 50): Promise<AuditArchiveSummary[]> {
    return this.repository.findArchiveSummaries(organizationId, Math.min(Math.max(limit, 1), 100));
  }

  /**
   * Reads back the records of one archive batch.
   *
   * The payload is decompressed and its checksum verified before it is
   * returned, so a corrupted archive surfaces as an error instead of as
   * silently mangled audit records.
   *
   * @throws NotFoundException when the batch does not exist or belongs to
   * another organization.
   */
  async readArchive(organizationId: string, batchId: string): Promise<ArchivableAuditLog[]> {
    const batch = await this.repository.findArchiveSummary(organizationId, batchId);
    if (!batch) {
      throw new NotFoundException(`Audit archive '${batchId}' was not found`);
    }

    const payload = await this.repository.findArchivePayload(batchId);
    if (!payload) {
      throw new NotFoundException(`Audit archive '${batchId}' was not found`);
    }

    const decompressed = gunzipSync(payload);
    if (sha256(decompressed) !== batch.checksum) {
      throw new Error(`Audit archive '${batchId}' failed its checksum and cannot be read`);
    }

    const records = JSON.parse(decompressed.toString('utf8')) as ArchivableAuditLog[];
    return records.map((record) => ({
      ...record,
      // Dates are serialized as ISO strings; restore them so the callers see
      // the same shape as a live audit row.
      createdAt: new Date(record.createdAt),
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Archives one batch of records of a single organization.
   *
   * The order is deliberate: write → verify → delete. The source rows are only
   * removed once the compressed batch has been read back and its checksum and
   * record count match.
   */
  private async archiveBatch(
    organizationId: string,
    records: ArchivableAuditLog[],
    cutoff: Date,
  ): Promise<{ archivedRecords: number; deletedRecords: number }> {
    const batchId = batchIdFor(records);
    const serialized = Buffer.from(JSON.stringify(records), 'utf8');
    const payload = gzipSync(serialized);
    const checksum = sha256(serialized);
    const chainBoundaryHash = lastHashOf(records);
    const archivedThrough = records[records.length - 1].createdAt;

    await this.repository.createArchive({
      batchId,
      organizationId,
      cutoff,
      recordCount: records.length,
      payload,
      checksum,
      chainBoundaryHash,
      archivedThrough,
    });

    await this.verifyArchive(batchId, checksum, records.length);

    const deleted = await this.repository.deleteAuditLogs(records.map((record) => record.id));

    this.logger.log(
      `Archived ${records.length} audit record(s) of organization ${organizationId} (batch ${batchId.slice(0, 12)}…, ${deleted.count} removed from the active table)`,
    );

    return { archivedRecords: records.length, deletedRecords: deleted.count };
  }

  /**
   * Reads the stored batch back and verifies it. Throws when the archive is
   * missing, incomplete or corrupted, which keeps the source rows in place.
   */
  private async verifyArchive(
    batchId: string,
    checksum: string,
    expectedCount: number,
  ): Promise<void> {
    const stored = await this.repository.findArchiveByBatchId(batchId);
    if (!stored) {
      throw new Error(`Audit archive ${batchId} could not be read back; source records are kept`);
    }
    if (stored.recordCount !== expectedCount) {
      throw new Error(
        `Audit archive ${batchId} holds ${stored.recordCount} records instead of ${expectedCount}; source records are kept`,
      );
    }
    const decompressed = gunzipSync(Buffer.from(stored.payload));
    if (sha256(decompressed) !== stored.checksum || stored.checksum !== checksum) {
      throw new Error(`Audit archive ${batchId} failed its checksum; source records are kept`);
    }
  }
}

/** Groups the selected records by organization, preserving the chain order. */
function groupByOrganization(records: ArchivableAuditLog[]): Map<string, ArchivableAuditLog[]> {
  const groups = new Map<string, ArchivableAuditLog[]>();
  for (const record of records) {
    const group = groups.get(record.organizationId);
    if (group) {
      group.push(record);
    } else {
      groups.set(record.organizationId, [record]);
    }
  }
  return groups;
}

/**
 * Deterministic id of a batch: the same set of records always produces the
 * same id, which is what makes writing the archive idempotent.
 */
export function batchIdFor(records: ArchivableAuditLog[]): string {
  const ids = records.map((record) => record.id).sort();
  return sha256(ids.join(','));
}

/** The hash of the last archived entry that carries one — the chain anchor. */
function lastHashOf(records: ArchivableAuditLog[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const hash = records[index].hash;
    if (hash) {
      return hash;
    }
  }
  return null;
}

/** SHA-256 of a buffer, hex encoded. */
function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

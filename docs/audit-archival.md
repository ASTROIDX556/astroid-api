# Audit Log Archival

Autonomous agents generate audit records at a high rate. The archival job
moves the records that are older than the configured retention period out of
the actively queried `audit_logs` table into a compressed archive, so the hot
table — and every query against it — stays small while the audit history is
preserved.

## Architecture

| Piece | Location | Responsibility |
|-------|----------|----------------|
| Scheduler | `src/modules/audit/audit-archive.scheduler.ts` | Enqueues the archival job once per hour. |
| Worker | `src/modules/audit/queues/audit-archive.worker.ts` | Consumes the job with the shared retry/backoff policy. |
| Service | `src/modules/audit/audit-archive.service.ts` | Selects, archives and removes the expired records. |
| Repository | `src/modules/audit/audit-archive.repository.ts` | Reads the expired records and writes the archive. |

The scheduler only enqueues work; the archival itself runs in the BullMQ
worker, where it inherits the platform-wide retry policy (three attempts with
exponential backoff) and the structured worker logging.

## Storage strategy: compressed partitions

The repository has no object-storage client, so the archive is a **compressed
partition inside PostgreSQL**: one `audit_log_archives` row per batch holding

- the archived rows as a single gzip-compressed JSON document,
- a SHA-256 checksum of the uncompressed payload,
- the number of archived rows,
- the hash-chain anchor of the batch.

This keeps the archive queryable for compliance reviews, needs no new
infrastructure and satisfies the requirement of the issue ("cold storage or
compressed partitions"). The table is only ever appended to, never queried by
the hot path.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUDIT_ARCHIVE_ENABLED` | `true` | Enables the scheduled job. |
| `AUDIT_ARCHIVE_RETENTION_DAYS` | `30` | Age at which a record becomes eligible for archival. |
| `AUDIT_ARCHIVE_BATCH_SIZE` | `500` | Maximum number of records per organization and batch. |
| `AUDIT_ARCHIVE_MAX_BATCHES` | `20` | Maximum number of batches per run. |
| `AUDIT_RETENTION_DAYS` | `90` | Hard-delete retention of the cleanup job. |

The startup validation rejects an archive cutoff that is not below the
delete retention: records must be archived before the cleanup job may delete
them.

## Safety properties

- **Bounded work.** A run selects at most `AUDIT_ARCHIVE_BATCH_SIZE` records
  per batch and processes at most `AUDIT_ARCHIVE_MAX_BATCHES` batches, so the
  table is never locked for long and memory usage stays flat.
- **Nothing is deleted before it is archived.** The order is *write → verify →
  delete*: the compressed batch is stored, read back and checked (record count
  and checksum) before the source rows are removed. A failure in between
  leaves the records in place.
- **Idempotent.** The batch id is the SHA-256 of the archived row ids, so the
  same set of records always maps to the same archive. A retried run reuses
  the existing archive (`skipDuplicates`) instead of writing a second copy,
  and deleting already-removed rows is a no-op.
- **Partial failures are safe.** Batches are archived per organization. When
  one organization fails, the organizations that were already archived stay
  archived and the run is retried; the failed organization keeps its records.
- **Chain preserving.** The oldest records are archived first, so the archived
  rows of an organization are always a *prefix* of its hash chain. The hash of
  the last archived entry is stored with the batch and anchors the live rows,
  which keeps `GET /audit/integrity/verify` meaningful across the archive
  boundary.

## Reading the archive

Archived records stay accessible:

- `GET /audit/archives` lists the batches of the organization (metadata only).
- `GET /audit/archives/:batchId` returns the records of one batch. The
  compressed payload is decompressed and its checksum verified before it is
  returned, so a corrupted archive surfaces as an error instead of as silently
  mangled audit records. A batch of another organization is reported as `404`.

## Observability

- Structured logs: one line per run (cutoff, batch size, archived records,
  duration) and one line per archived batch.
- Metrics: `audit_archived_records_total{status="archived"|"deleted"}` counts
  the processed records, and the worker instrumentation adds
  `worker_jobs_total` and `worker_job_duration_seconds` for the queue.
- A failed run is rethrown so BullMQ retries it; a terminal failure is routed
  to the dead-letter queue by the shared queue failure listener.

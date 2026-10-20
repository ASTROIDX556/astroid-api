import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * An audit row as it is stored in the archive. The shape mirrors the
 * `audit_logs` table so the archived payload can be restored verbatim.
 */
export interface ArchivableAuditLog {
  id: string;
  organizationId: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  oldValue: Prisma.JsonValue | null;
  newValue: Prisma.JsonValue | null;
  ipAddress: string | null;
  device: string | null;
  requestId: string | null;
  sourceEventId: string | null;
  previousHash: string | null;
  hash: string | null;
  createdAt: Date;
}

/** The archive row that holds one batch of archived audit records. */
export interface AuditArchiveRecord {
  batchId: string;
  organizationId: string;
  cutoff: Date;
  recordCount: number;
  payload: Buffer;
  checksum: string;
  chainBoundaryHash: string | null;
  archivedThrough: Date;
}

/**
 * The metadata of one archive batch, without the compressed payload. It is the
 * shape returned by the archive listing so a caller can discover which
 * batches exist before fetching the records of one of them.
 */
export interface AuditArchiveSummary {
  batchId: string;
  organizationId: string;
  cutoff: Date;
  recordCount: number;
  checksum: string;
  chainBoundaryHash: string | null;
  archivedThrough: Date;
  createdAt: Date;
}

/**
 * Persistence for the audit archive.
 *
 * The archive is a compressed partition: one row per batch holding the
 * gzip-compressed JSON of the archived audit records. Batches are addressed by
 * a deterministic `batchId`, which makes writing a batch idempotent.
 */
@Injectable()
export class AuditArchiveRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the audit rows that are older than the cutoff, oldest first.
   *
   * The ordering matters: the oldest rows are always archived first, so the
   * archived set of an organization is always a *prefix* of its hash chain and
   * the chain stays verifiable across the archive boundary.
   */
  findArchivable(cutoff: Date, limit: number): Promise<ArchivableAuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  /**
   * Stores a batch. A batch that already exists is left untouched, so a
   * retried run never creates a duplicate archive.
   */
  async createArchive(record: AuditArchiveRecord): Promise<void> {
    await this.prisma.auditLogArchive.createMany({
      data: [
        {
          batchId: record.batchId,
          organizationId: record.organizationId,
          cutoff: record.cutoff,
          recordCount: record.recordCount,
          payload: record.payload,
          checksum: record.checksum,
          chainBoundaryHash: record.chainBoundaryHash,
          archivedThrough: record.archivedThrough,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Reads a stored batch back so it can be verified before the source is deleted. */
  findArchiveByBatchId(batchId: string) {
    return this.prisma.auditLogArchive.findUnique({ where: { batchId } });
  }

  /**
   * Reads the metadata of one batch of an organization. Scoping the lookup by
   * the organization keeps a batch of another tenant unreadable, and querying
   * the batch directly keeps the lookup correct no matter how many archives
   * the organization has.
   */
  findArchiveSummary(organizationId: string, batchId: string): Promise<AuditArchiveSummary | null> {
    return this.prisma.auditLogArchive
      .findUnique({
        where: { batchId },
        select: {
          batchId: true,
          organizationId: true,
          cutoff: true,
          recordCount: true,
          checksum: true,
          chainBoundaryHash: true,
          archivedThrough: true,
          createdAt: true,
        },
      })
      .then((row) => (row && row.organizationId === organizationId ? row : null));
  }

  /**
   * Reads the raw (still compressed) payload of a batch. The caller
   * decompresses and verifies it, so a corrupted batch never surfaces as
   * readable audit records.
   */
  findArchivePayload(batchId: string): Promise<Buffer | null> {
    return this.prisma.auditLogArchive
      .findUnique({ where: { batchId }, select: { payload: true } })
      .then((row) => (row ? Buffer.from(row.payload) : null));
  }

  /**
   * Lists the archive batches of an organization, newest first. Only the
   * metadata is returned — the compressed payloads are fetched one batch at a
   * time so a listing never loads the whole archive into memory.
   */
  findArchiveSummaries(organizationId: string, limit: number): Promise<AuditArchiveSummary[]> {
    return this.prisma.auditLogArchive.findMany({
      where: { organizationId },
      orderBy: [{ archivedThrough: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      select: {
        batchId: true,
        organizationId: true,
        cutoff: true,
        recordCount: true,
        checksum: true,
        chainBoundaryHash: true,
        archivedThrough: true,
        createdAt: true,
      },
    });
  }

  /** Removes the archived rows from the actively queried table. */
  deleteAuditLogs(ids: string[]): Promise<Prisma.BatchPayload> {
    return this.prisma.auditLog.deleteMany({ where: { id: { in: ids } } });
  }
}

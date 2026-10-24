import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AuditArchiveService, batchIdFor } from '../audit-archive.service';
import { AuditArchiveRepository, ArchivableAuditLog } from '../audit-archive.repository';
import { MetricsService } from '../../metrics/metrics.service';
import { ConfigService } from '@nestjs/config';

const NOW = new Date('2026-10-20T12:00:00.000Z');

/** Builds an audit row that is `days` old relative to {@link NOW}. */
function auditRow(overrides: Partial<ArchivableAuditLog> = {}): ArchivableAuditLog {
  return {
    id: 'log-1',
    organizationId: 'org-1',
    userId: 'user-1',
    action: 'TRANSFER_FUNDS',
    entity: 'transaction',
    entityId: 'tx-1',
    oldValue: null,
    newValue: { amount: '10' },
    ipAddress: null,
    device: null,
    requestId: null,
    sourceEventId: null,
    previousHash: 'prev-hash',
    hash: 'hash-1',
    createdAt: new Date(NOW.getTime() - 40 * 86_400_000),
    ...overrides,
  };
}

/** In-memory stand-in for the archive repository. */
class FakeArchiveRepository {
  readonly archives = new Map<string, Record<string, unknown>>();
  readonly deleted: string[][] = [];
  failOnCreate = false;
  failOnRead = false;
  corruptOnRead = false;

  constructor(private pending: ArchivableAuditLog[] = []) {}

  findArchivable = vi.fn(async (_cutoff: Date, limit: number) => this.pending.slice(0, limit));

  createArchive = vi.fn(
    async (record: {
      batchId: string;
      payload: Buffer;
      checksum: string;
      recordCount: number;
      chainBoundaryHash: string | null;
      archivedThrough: Date;
      organizationId: string;
      cutoff: Date;
    }) => {
      if (this.failOnCreate) {
        throw new Error('archive write failed');
      }
      if (!this.archives.has(record.batchId)) {
        this.archives.set(record.batchId, { ...record, createdAt: new Date() });
      }
    },
  );

  findArchiveByBatchId = vi.fn(async (batchId: string) => {
    if (this.failOnRead) {
      throw new Error('archive read failed');
    }
    const stored = this.archives.get(batchId);
    if (!stored) {
      return null;
    }
    if (this.corruptOnRead) {
      return { ...stored, checksum: 'tampered' };
    }
    return stored;
  });

  findArchiveSummaries = vi.fn(async (organizationId: string, limit: number) =>
    [...this.archives.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .slice(0, limit),
  );

  findArchiveSummary = vi.fn(async (organizationId: string, batchId: string) => {
    const stored = this.archives.get(batchId);
    if (!stored || stored.organizationId !== organizationId) {
      return null;
    }
    return stored;
  });

  findArchivePayload = vi.fn(async (batchId: string) => {
    const stored = this.archives.get(batchId);
    if (!stored) {
      return null;
    }
    return Buffer.from(stored.payload as Buffer);
  });

  deleteAuditLogs = vi.fn(async (ids: string[]) => {
    this.deleted.push(ids);
    const removed = new Set(ids);
    this.pending = this.pending.filter((row) => !removed.has(row.id));
    return { count: ids.length };
  });
}

describe('AuditArchiveService', () => {
  let repository: FakeArchiveRepository;
  let metrics: { recordAuditArchive: ReturnType<typeof vi.fn> };
  let service: AuditArchiveService;

  function buildService(
    selection: ArchivableAuditLog[] = [],
    settings: Partial<{
      archiveEnabled: boolean;
      archiveRetentionDays: number;
      archiveBatchSize: number;
      archiveMaxBatches: number;
      retentionDays: number;
    }> = {},
  ): void {
    repository = new FakeArchiveRepository(selection);
    metrics = { recordAuditArchive: vi.fn() };
    const config = {
      get: vi.fn().mockReturnValue({
        archiveEnabled: true,
        archiveRetentionDays: 30,
        archiveBatchSize: 500,
        archiveMaxBatches: 20,
        retentionDays: 90,
        ...settings,
      }),
    } as unknown as ConfigService;
    service = new AuditArchiveService(
      repository as unknown as AuditArchiveRepository,
      config,
      metrics as unknown as MetricsService,
    );
  }

  beforeEach(() => {
    buildService();
  });

  describe('retention cutoff', () => {
    it('computes the cutoff from the configured retention', () => {
      buildService([], { archiveRetentionDays: 30 });
      expect(service.retentionCutoff(NOW).toISOString()).toBe(
        new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      );
    });

    it('uses the configured retention days', () => {
      buildService([], { archiveRetentionDays: 7 });
      expect(service.retentionDays).toBe(7);
    });

    it('selects only the records that are older than the cutoff', async () => {
      await service.archive(NOW);
      const [cutoff] = repository.findArchivable.mock.calls[0] as [Date, number];
      expect(cutoff.getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
    });
  });

  describe('archive', () => {
    it('does nothing when there is nothing to archive', async () => {
      const result = await service.archive(NOW);

      expect(result.archivedRecords).toBe(0);
      expect(result.batches).toBe(0);
      expect(repository.createArchive).not.toHaveBeenCalled();
      expect(repository.deleteAuditLogs).not.toHaveBeenCalled();
    });

    it('archives a batch and removes it from the active table', async () => {
      const rows = [auditRow({ id: 'log-1' }), auditRow({ id: 'log-2', hash: 'hash-2' })];
      buildService([...rows]);

      const result = await service.archive(NOW);

      expect(result.archivedRecords).toBe(2);
      expect(result.deletedRecords).toBe(2);
      expect(repository.createArchive).toHaveBeenCalledTimes(1);
      expect(repository.deleteAuditLogs).toHaveBeenCalledWith(['log-1', 'log-2']);
    });

    it('stores the compressed payload with a checksum and the chain anchor', async () => {
      const rows = [
        auditRow({ id: 'log-1', hash: 'hash-1' }),
        auditRow({ id: 'log-2', hash: 'hash-2' }),
      ];
      buildService([...rows]);

      await service.archive(NOW);

      const stored = [...repository.archives.values()][0] as {
        payload: Buffer;
        checksum: string;
        chainBoundaryHash: string;
        recordCount: number;
      };
      expect(stored.recordCount).toBe(2);
      expect(stored.chainBoundaryHash).toBe('hash-2');
      const decompressed = gunzipSync(stored.payload).toString('utf8');
      expect(JSON.parse(decompressed)).toHaveLength(2);
      expect(stored.checksum).toBe(
        createHash('sha256').update(Buffer.from(decompressed, 'utf8')).digest('hex'),
      );
    });

    it('never deletes the source records when the archive cannot be written', async () => {
      buildService([auditRow()]);
      repository.failOnCreate = true;

      await expect(service.archive(NOW)).rejects.toThrow('archive write failed');
      expect(repository.deleteAuditLogs).not.toHaveBeenCalled();
    });

    it('never deletes the source records when the archive cannot be read back', async () => {
      buildService([auditRow()]);
      repository.failOnRead = true;

      await expect(service.archive(NOW)).rejects.toThrow('archive read failed');
      expect(repository.deleteAuditLogs).not.toHaveBeenCalled();
    });

    it('never deletes the source records when the archive fails its checksum', async () => {
      buildService([auditRow()]);
      repository.corruptOnRead = true;

      await expect(service.archive(NOW)).rejects.toThrow(/checksum/);
      expect(repository.deleteAuditLogs).not.toHaveBeenCalled();
    });

    it('archives the organizations of a batch independently', async () => {
      buildService([
        auditRow({ id: 'log-1', organizationId: 'org-1' }),
        auditRow({ id: 'log-2', organizationId: 'org-2' }),
      ]);

      const result = await service.archive(NOW);

      expect(result.batches).toBe(2);
      expect(repository.createArchive).toHaveBeenCalledTimes(2);
      const organizations = repository.createArchive.mock.calls.map(
        (call) => (call[0] as { organizationId: string }).organizationId,
      );
      expect(organizations).toEqual(['org-1', 'org-2']);
    });

    it('keeps the batches that were archived when a later batch fails', async () => {
      buildService([
        auditRow({ id: 'log-1', organizationId: 'org-1' }),
        auditRow({ id: 'log-2', organizationId: 'org-2' }),
      ]);
      repository.createArchive = vi.fn(async (record: { batchId: string }) => {
        if (record.batchId === batchIdFor([auditRow({ id: 'log-2', organizationId: 'org-2' })])) {
          throw new Error('archive write failed');
        }
        repository.archives.set(record.batchId, { ...record });
      });

      await expect(service.archive(NOW)).rejects.toThrow('archive write failed');
      // The first organization was archived and removed before the failure.
      expect(repository.deleted).toEqual([['log-1']]);
    });

    it('stops after the configured number of batches', async () => {
      buildService(
        [auditRow({ id: 'log-1' }), auditRow({ id: 'log-2' }), auditRow({ id: 'log-3' })],
        { archiveMaxBatches: 2, archiveBatchSize: 1 },
      );

      const result = await service.archive(NOW);

      expect(result.batches).toBe(2);
      expect(repository.createArchive).toHaveBeenCalledTimes(2);
    });

    it('never selects more records than the configured batch size', async () => {
      buildService([auditRow({ id: 'log-1' })], { archiveBatchSize: 1 });

      await service.archive(NOW);

      expect(repository.findArchivable).toHaveBeenCalledWith(expect.any(Date), 1);
    });

    it('is idempotent: a second run finds nothing left to archive', async () => {
      const rows = [auditRow({ id: 'log-1' })];
      buildService([...rows]);

      await service.archive(NOW);
      const firstArchives = repository.archives.size;
      const second = await service.archive(NOW);

      expect(firstArchives).toBe(1);
      expect(second.archivedRecords).toBe(0);
      expect(repository.createArchive).toHaveBeenCalledTimes(1);
    });

    it('reuses the same archive when the same records are archived again', async () => {
      const rows = [auditRow({ id: 'log-1' })];
      buildService([...rows]);

      await service.archive(NOW);
      const batchId = batchIdFor(rows);
      // Simulate a retry that selects the very same rows again.
      repository.createArchive.mockClear();
      await service.archive(NOW);

      expect(repository.archives.size).toBe(1);
      expect(repository.archives.has(batchId)).toBe(true);
    });

    it('reports the processed records to the metrics', async () => {
      buildService([auditRow({ id: 'log-1' }), auditRow({ id: 'log-2' })]);

      await service.archive(NOW);

      expect(metrics.recordAuditArchive).toHaveBeenCalledWith(2, 'archived');
      expect(metrics.recordAuditArchive).toHaveBeenCalledWith(2, 'deleted');
    });

    it('records a failure metric when the archival fails', async () => {
      buildService([auditRow()]);
      repository.failOnCreate = true;

      await expect(service.archive(NOW)).rejects.toThrow('archive write failed');

      expect(metrics.recordAuditArchive).toHaveBeenCalledWith(0, 'failed');
    });

    it('does not archive anything while the archival is disabled', async () => {
      buildService([auditRow()], { archiveEnabled: false });

      const result = await service.archive(NOW);

      expect(result.archivedRecords).toBe(0);
      expect(result.batches).toBe(0);
      expect(repository.createArchive).not.toHaveBeenCalled();
      expect(repository.deleteAuditLogs).not.toHaveBeenCalled();
    });
  });

  describe('read path', () => {
    it('lists the archived batches of an organization', async () => {
      buildService([auditRow({ id: 'log-1' })]);
      await service.archive(NOW);

      const batches = await service.listArchives('org-1');

      expect(batches).toHaveLength(1);
      expect(batches[0].recordCount).toBe(1);
      expect(batches[0].organizationId).toBe('org-1');
    });

    it('never lists the batches of another organization', async () => {
      buildService([auditRow({ id: 'log-1', organizationId: 'org-1' })]);
      await service.archive(NOW);

      const batches = await service.listArchives('org-2');

      expect(batches).toHaveLength(0);
    });

    it('reads the records of an archived batch back', async () => {
      buildService([auditRow({ id: 'log-1' }), auditRow({ id: 'log-2' })]);
      await service.archive(NOW);

      const records = await service.readArchive(
        'org-1',
        batchIdFor([auditRow({ id: 'log-1' }), auditRow({ id: 'log-2' })]),
      );

      expect(records).toHaveLength(2);
      expect(records[0].id).toBe('log-1');
      expect(records[0].action).toBe('TRANSFER_FUNDS');
      // The dates survive the round trip through the compressed payload.
      expect(records[0].createdAt).toBeInstanceOf(Date);
    });

    it('refuses to read a batch that belongs to another organization', async () => {
      buildService([auditRow({ id: 'log-1' })]);
      await service.archive(NOW);

      await expect(
        service.readArchive('org-2', batchIdFor([auditRow({ id: 'log-1' })])),
      ).rejects.toThrow(/was not found/);
    });

    it('refuses to read a batch that fails its checksum', async () => {
      buildService([auditRow({ id: 'log-1' })]);
      await service.archive(NOW);

      const stored = [...repository.archives.values()][0] as { checksum: string };
      stored.checksum = 'tampered';

      await expect(
        service.readArchive('org-1', batchIdFor([auditRow({ id: 'log-1' })])),
      ).rejects.toThrow(/checksum/);
    });
  });

  describe('batchIdFor', () => {
    it('is stable regardless of the order of the records', () => {
      const first = batchIdFor([auditRow({ id: 'a' }), auditRow({ id: 'b' })]);
      const second = batchIdFor([auditRow({ id: 'b' }), auditRow({ id: 'a' })]);
      expect(first).toBe(second);
    });

    it('differs for a different set of records', () => {
      expect(batchIdFor([auditRow({ id: 'a' })])).not.toBe(batchIdFor([auditRow({ id: 'b' })]));
    });
  });
});

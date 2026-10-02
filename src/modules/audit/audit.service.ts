import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'stream';
import { AuditRepository, CreateAuditLogData } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { ExportAuditLogsQuery, StreamAuditLogsQuery } from './audit-export.dto';
import { sanitizeAuditPayload } from '../../common/helpers/audit-sanitizer';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';

const SORTABLE = ['createdAt', 'action', 'entity'];
import { CursorPaginated } from '../../common/interfaces/api-response.interface';
import { AuditListQuery } from './audit-list.dto';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';

/** An audit row as returned by `AuditRepository.exportLogs`, with its joined user. */
type ExportedAuditLog = Prisma.AuditLogGetPayload<{
  include: { user: { select: { id: true; email: true; name: true } } };
}>;

const CSV_HEADERS = [
  'id',
  'organizationId',
  'userId',
  'userEmail',
  'action',
  'entity',
  'entityId',
  'ipAddress',
  'device',
  'oldValue',
  'newValue',
  'createdAt',
];

function redactAuditLog(record: ExportedAuditLog): ExportedAuditLog {
  return {
    ...record,
    oldValue: sanitizeAuditPayload(record.oldValue),
    newValue: sanitizeAuditPayload(record.newValue),
  };
}

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatCsvRow(record: ExportedAuditLog): string {
  return [
    record.id,
    record.organizationId,
    record.userId,
    record.user?.email ?? '',
    record.action,
    record.entity,
    record.entityId,
    record.ipAddress,
    record.device,
    record.oldValue,
    record.newValue,
    record.createdAt ? new Date(record.createdAt).toISOString() : '',
  ].map(escapeCsvField).join(',');
}

/**
 * Writes and queries the immutable audit trail. Records Who / When / Where /
 * Why / Old / New for every important action. Never updates or deletes.
 * Integrates cryptographic hash chaining for tamper-evident audit history.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly hashService: AuditHashService,
  ) {}

  async record(data: CreateAuditLogData) {
    const previousHash = await this.hashService.getLatestHash(data.organizationId);
    const createdAt = new Date();

    const hashResult = this.hashService.computeEntryHash(
      {
        organizationId: data.organizationId,
        userId: data.userId,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId,
        oldValue: data.oldValue,
        newValue: data.newValue,
        ipAddress: data.ipAddress,
        device: data.device,
        createdAt,
      },
      previousHash,
    );

    return this.repository.create({
      ...data,
      requestId: data.requestId ?? null,
      previousHash: hashResult.previousHash,
      hash: hashResult.hash,
    });
  }

  async list(organizationId: string, query: AuditListQuery) {
    const where: Prisma.AuditLogWhereInput = { organizationId };
    if (query.actorId) where.userId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.resourceId) where.entityId = query.resourceId;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
    const records = await this.repository.findPage(where, cursor, query.limit + 1);
    const hasNext = records.length > query.limit;
    const items = hasNext ? records.slice(0, query.limit) : records;
    const lastItem = items.at(-1);
    const nextCursor = hasNext && lastItem
      ? encodeAuditCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
      : null;

    return new CursorPaginated(items, { limit: query.limit, hasNext, nextCursor });
  }

  async export(organizationId: string, query: ExportAuditLogsQuery) {
    const where = this.buildExportWhere(organizationId, query);
    const limit = Math.min(query.limit ?? 100, 1000);
    const records = await this.repository.exportLogs(where, limit, query.cursor);

    let nextCursor: string | null = null;
    let items = records;
    if (records.length > limit) {
      items = records.slice(0, limit);
      nextCursor = items[items.length - 1]?.id ?? null;
    }

    const safeItems = items.map(redactAuditLog);
    if (query.format === 'csv') {
      return {
        format: 'csv',
        data: this.formatAsCsv(safeItems),
        count: safeItems.length,
        nextCursor,
      };
    }

    return {
      format: 'json',
      data: safeItems,
      count: safeItems.length,
      nextCursor,
    };
  }

  /**
   * Streams filtered audit rows as a JSON array or CSV without buffering the
   * complete export in memory.
   */
  streamExport(organizationId: string, query: StreamAuditLogsQuery): Readable {
    const records = this.repository.streamLogs(
      this.buildExportWhere(organizationId, query),
      query.batchSize,
      query.cursor,
    );
    return Readable.from(
      query.format === 'csv' ? this.streamCsv(records) : this.streamJson(records),
    );
  }

  private buildExportWhere(
    organizationId: string,
    query: Pick<
      ExportAuditLogsQuery,
      'agentId' | 'userId' | 'actionType' | 'severity' | 'startDate' | 'endDate'
    >,
  ): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = { organizationId };
    const and: Prisma.AuditLogWhereInput[] = [];

    if (query.userId) where.userId = query.userId;
    if (query.actionType) where.action = query.actionType;
    if (query.agentId) {
      and.push({
        OR: [
        { entityId: query.agentId },
        {
          oldValue: {
            path: ['agentId'],
            equals: query.agentId,
          },
        },
        {
          newValue: {
            path: ['agentId'],
            equals: query.agentId,
          },
        },
        ],
      });
    }

    if (query.severity) {
      and.push({
        OR: [
          { oldValue: { path: ['severity'], equals: query.severity } },
          { newValue: { path: ['severity'], equals: query.severity } },
        ],
      });
    }

    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) {
        where.createdAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        where.createdAt.lte = new Date(query.endDate);
      }
    }

    if (and.length) {
      where.AND = and;
    }
    return where;
  }

  private async *streamJson(records: AsyncIterable<ExportedAuditLog>): AsyncGenerator<string> {
    yield '[';
    let isFirst = true;
    for await (const record of records) {
      yield `${isFirst ? '' : ','}${JSON.stringify(redactAuditLog(record))}`;
      isFirst = false;
    }
    yield ']';
  }

  private async *streamCsv(records: AsyncIterable<ExportedAuditLog>): AsyncGenerator<string> {
    yield `${CSV_HEADERS.join(',')}\n`;
    for await (const record of records) {
      yield `${formatCsvRow(redactAuditLog(record))}\n`;
    }
  }

  formatAsCsv(records: ExportedAuditLog[]): string {
    return [CSV_HEADERS.join(','), ...records.map(formatCsvRow)].join('\n');
  }

  findById(organizationId: string, id: string) {
    return this.repository.findById(organizationId, id);
  }

  /**
   * Verifies the integrity of the entire audit chain for an organization.
   * Returns detailed information about chain validity.
   */
  async verifyIntegrity(organizationId: string) {
    return this.hashService.verifyChainIntegrity(organizationId);
  }

  /**
   * Verifies the integrity of a single audit log entry.
   */
  async verifyEntryIntegrity(entryId: string, organizationId: string) {
    return this.hashService.verifyEntryIntegrity(entryId, organizationId);
  }
}

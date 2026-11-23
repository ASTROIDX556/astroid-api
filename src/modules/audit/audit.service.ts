import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditRepository, CreateAuditLogData } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { CursorPaginated, Paginated } from '../../common/interfaces/api-response.interface';
import { AuditListQuery, AUDIT_DEFAULT_PAGE_SIZE } from './audit-list.dto';
import { AuditTimelineQuery } from './audit-timeline.dto';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';
import { ExportAuditLogsQuery, StreamAuditLogsQuery } from './audit-export.dto';
import { sanitizeAuditPayload } from '../../common/helpers/audit-sanitizer';
import { buildPaginationMeta } from '../../common/helpers/pagination';

/** An audit row as returned by `AuditRepository.exportLogs`, with its joined user. */
type ExportedAuditLog = Prisma.AuditLogGetPayload<{
  include: { user: { select: { id: true; email: true; name: true } } };
}>;

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
    const safeData: CreateAuditLogData = {
      ...data,
      ...(data.oldValue === undefined ? {} : { oldValue: sanitizeAuditPayload(data.oldValue) }),
      ...(data.newValue === undefined ? {} : { newValue: sanitizeAuditPayload(data.newValue) }),
    };
    return this.repository.createChained({
      ...safeData,
      requestId: data.requestId ?? null,
    }, (id, prevHash, timestamp) => this.hashService.computeEntryHash(
      {
        id,
        organizationId: safeData.organizationId,
        userId: safeData.userId,
        action: safeData.action,
        entity: safeData.entity,
        entityId: safeData.entityId,
        oldValue: safeData.oldValue,
        newValue: safeData.newValue,
        ipAddress: safeData.ipAddress,
        device: safeData.device,
        createdAt: timestamp,
      },
      prevHash,
    ).hash);
  }

  /** Audit log listing, preserving cursor mode and adding standard page mode. */
  async list(
    organizationId: string,
    query: AuditListQuery & { cursor: string },
  ): Promise<CursorPaginated<ExportedAuditLog>>;
  async list(
    organizationId: string,
    query: AuditListQuery,
  ): Promise<CursorPaginated<ExportedAuditLog> | Paginated<ExportedAuditLog>>;
  async list(organizationId: string, query: AuditListQuery): Promise<CursorPaginated<ExportedAuditLog> | Paginated<ExportedAuditLog>> {
    const where = this.buildFilterWhere(organizationId, query);
    if (!query.cursor) {
      const { items, total } = await this.repository.findManyAndCount(where, {
        skip: query.offset ?? 0,
        take: query.limit ?? AUDIT_DEFAULT_PAGE_SIZE,
        orderBy: { createdAt: 'desc' },
      });
      return new Paginated(items as ExportedAuditLog[], buildPaginationMeta(total, query));
    }
    const cursor = decodeAuditCursor(query.cursor);
    const take = (query.limit ?? AUDIT_DEFAULT_PAGE_SIZE) + 1;
    const rows = (await this.repository.findPage(where, cursor, take)) as ExportedAuditLog[];

    return this.toCursorPage(rows, query.limit ?? AUDIT_DEFAULT_PAGE_SIZE);
  }

  /**
   * Ascending audit timeline for one resource. Uses the same opaque `(createdAt,
   * id)` cursor as the listing, with the comparison direction inverted.
   */
  async timeline(
    organizationId: string,
    resourceId: string,
    query: AuditTimelineQuery,
  ): Promise<CursorPaginated<ExportedAuditLog>> {
    const where = this.buildFilterWhere(organizationId, {
      resourceId,
      from: query.from,
      to: query.to,
    });
    const limit = query.limit;
    const rows = (await this.repository.findPage(
      where,
      query.cursor ? decodeAuditCursor(query.cursor) : undefined,
      limit + 1,
      'asc',
    )) as ExportedAuditLog[];

    return this.toCursorPage(rows, limit);
  }

  /** Turns a `limit + 1` database fetch into a cursor page with stable meta. */
  private toCursorPage(rows: ExportedAuditLog[], limit: number): CursorPaginated<ExportedAuditLog> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
      : null;

    return new CursorPaginated(items, { limit, hasMore, nextCursor });
  }

  async export(organizationId: string, query: ExportAuditLogsQuery) {
    const where = this.buildFilterWhere(organizationId, query);
    const limit = Math.min(query.limit ?? 100, 1000);
    const records = await this.repository.exportLogs(where, limit, query.cursor);

    let nextCursor: string | null = null;
    let items = records;
    if (records.length > limit) {
      items = records.slice(0, limit);
      nextCursor = items[items.length - 1]?.id ?? null;
    }
    const sanitized = items.map((item) => this.sanitizeRecord(item));

    if (query.format === 'csv') {
      const csv = this.formatAsCsv(sanitized);
      return { format: 'csv', data: csv, count: sanitized.length, nextCursor };
    }

    return {
      format: 'json',
      data: sanitized,
      count: sanitized.length,
      nextCursor,
    };
  }

  /**
   * Streams an export in bounded batches so large exports never load the
   * full result set into memory. Yields Buffer chunks: a JSON array
   * (one record per chunk, wrapped by `[`/`]`) or raw CSV rows.
   */
  async *streamExport(organizationId: string, query: StreamAuditLogsQuery): AsyncGenerator<Buffer> {
    const where = this.buildFilterWhere(organizationId, query);
    const stream = this.repository.streamLogs(where, query.batchSize, query.cursor);

    if (query.format === 'csv') {
      const headers = [
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
      yield Buffer.from(`${headers.join(',')}\n`);
      for await (const record of stream) {
        const row = this.formatCsvRow(this.sanitizeRecord(record));
        yield Buffer.from(`${row}\n`);
      }
      return;
    }

    let first = true;
    yield Buffer.from('[');
    for await (const record of stream) {
      const sanitized = this.sanitizeRecord(record);
      yield Buffer.from(`${first ? '' : ','}${JSON.stringify(sanitized)}`);
      first = false;
    }
    yield Buffer.from(']');
  }

  /** Builds the shared tenant + filter predicate used by list, export and streamExport. */
  private buildFilterWhere(
    organizationId: string,
    query: {
      userId?: string;
      actionType?: string;
      agentId?: string;
      severity?: string;
      startDate?: string;
      endDate?: string;
      actorId?: string;
      action?: string;
      resourceType?: string;
      resourceId?: string;
      from?: string;
      to?: string;
    },
  ): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = { organizationId };
    const andConditions: Prisma.AuditLogWhereInput[] = [];

    if (query.userId) where.userId = query.userId;
    if (query.actorId) where.userId = query.actorId;
    if (query.actionType) where.action = query.actionType;
    if (query.action) where.action = query.action;
    if (query.resourceType) where.entity = query.resourceType;
    if (query.resourceId) where.entityId = query.resourceId;

    if (query.agentId) {
      andConditions.push({
        OR: [
          { entityId: query.agentId },
          { oldValue: { path: ['agentId'], equals: query.agentId } },
          { newValue: { path: ['agentId'], equals: query.agentId } },
        ],
      });
    }

    if (query.severity) {
      andConditions.push({
        OR: [
          { oldValue: { path: ['severity'], equals: query.severity } },
          { newValue: { path: ['severity'], equals: query.severity } },
        ],
      });
    }

    const gte = query.startDate ?? query.from;
    const lte = query.endDate ?? query.to;
    if (gte || lte) {
      where.createdAt = {};
      if (gte) where.createdAt.gte = new Date(gte);
      if (lte) where.createdAt.lte = new Date(lte);
    }

    if (andConditions.length > 0) where.AND = andConditions;

    return where;
  }

  /** Redacts sensitive payload fields from a raw audit row before it leaves the service. */
  private sanitizeRecord(record: ExportedAuditLog): ExportedAuditLog {
    return {
      ...record,
      oldValue: sanitizeAuditPayload(record.oldValue),
      newValue: sanitizeAuditPayload(record.newValue),
    };
  }

  private formatCsvRow(r: ExportedAuditLog): string {
    const escapeCsvField = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      escapeCsvField(r.id),
      escapeCsvField(r.organizationId),
      escapeCsvField(r.userId),
      escapeCsvField(r.user?.email ?? ''),
      escapeCsvField(r.action),
      escapeCsvField(r.entity),
      escapeCsvField(r.entityId),
      escapeCsvField(r.ipAddress),
      escapeCsvField(r.device),
      escapeCsvField(r.oldValue),
      escapeCsvField(r.newValue),
      escapeCsvField(r.createdAt ? new Date(r.createdAt).toISOString() : ''),
    ].join(',');
  }

  formatAsCsv(records: ExportedAuditLog[]): string {
    const headers = [
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
    const lines = [headers.join(','), ...records.map((r) => this.formatCsvRow(r))];
    return lines.join('\n');
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

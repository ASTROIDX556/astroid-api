import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditRepository, CreateAuditLogData } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';

const SORTABLE = ['createdAt', 'action', 'entity'];

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
      previousHash: hashResult.previousHash,
      hash: hashResult.hash,
    });
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.AuditLogWhereInput = { organizationId };
    if (query.search) {
      where.OR = [
        { action: { contains: query.search, mode: 'insensitive' } },
        { entity: { contains: query.search, mode: 'insensitive' } },
        { entityId: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.filter) {
      where.entity = query.filter;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query.page, query.limit));
  }

  async export(organizationId: string, query: import('./audit-export.dto').ExportAuditLogsQuery) {
    const where: Prisma.AuditLogWhereInput = { organizationId };

    if (query.userId) {
      where.userId = query.userId;
    }

    if (query.actionType) {
      where.action = query.actionType;
    }

    if (query.agentId) {
      where.OR = [
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
      ];
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

    const limit = Math.min(query.limit ?? 100, 1000);
    const records = await this.repository.exportLogs(where, limit, query.cursor);

    let nextCursor: string | null = null;
    let items = records;
    if (records.length > limit) {
      items = records.slice(0, limit);
      nextCursor = items[items.length - 1]?.id ?? null;
    }

    if (query.format === 'csv') {
      const csv = this.formatAsCsv(items);
      return { format: 'csv', data: csv, count: items.length, nextCursor };
    }

    return {
      format: 'json',
      data: items,
      count: items.length,
      nextCursor,
    };
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

    const escapeCsvField = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [headers.join(',')];
    for (const r of records) {
      const row = [
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
      ];
      lines.push(row.join(','));
    }

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

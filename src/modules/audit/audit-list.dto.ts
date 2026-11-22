import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isValidCursor } from '../../common/pagination/cursor-pagination';

export const auditListQuerySchema = z
  .object({
    cursor: z.string().max(256).refine(isValidCursor, 'Invalid cursor').optional(),
    offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    page: z.coerce.number().int().positive().max(1_000_000_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    actorId: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(120).optional(),
    resourceId: z.string().min(1).max(128).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.offset !== undefined && query.page !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['offset'], message: 'Provide either offset or page, not both' });
    }
    if (query.pageSize !== undefined && query.limit !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pageSize'], message: 'Provide either pageSize or limit, not both' });
    }
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '`to` must be greater than or equal to `from`',
      });
    }
  })
  .transform((query) => {
    const limit = query.pageSize ?? query.limit ?? 20;
    const page = query.page ?? (query.offset === undefined ? 1 : Math.floor(query.offset / limit) + 1);
    const offset = query.offset ?? (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ['page'], message: 'Pagination offset exceeds the supported range' }]);
    }
    return { ...query, limit, pageSize: limit, page, offset };
  });

export type AuditListQuery = {
  cursor?: string;
  limit?: number;
  pageSize?: number;
  page?: number;
  offset?: number;
  actorId?: string;
  action?: string;
  resourceId?: string;
  from?: string;
  to?: string;
};
/** An audit log entry as returned by the API. */
export class AuditLogEntryDto {
  @ApiProperty({ description: 'Audit log entry id', format: 'uuid', example: '018f0a1b-7777-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Action that was recorded', example: 'transaction.created' })
  action!: string;

  @ApiProperty({ description: 'Kind of entity the action was applied to', example: 'transaction' })
  entity!: string;

  @ApiPropertyOptional({ description: 'Id of the affected entity', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  entityId?: string;

  @ApiPropertyOptional({ description: 'User that performed the action', format: 'uuid' })
  userId?: string;

  @ApiPropertyOptional({ description: 'Client address the request came from', example: '203.0.113.7' })
  ipAddress?: string;

  @ApiPropertyOptional({ description: 'Device the request came from', example: 'curl/8.4.0' })
  device?: string;

  @ApiPropertyOptional({ description: 'Correlation id of the request', example: 'req_018f...' })
  requestId?: string;

  @ApiPropertyOptional({ type: Object, description: 'State before the action' })
  oldValue?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object, description: 'State after the action' })
  newValue?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Hash of the previous audit entry, or GENESIS for the first entry' })
  prevHash?: string;

  @ApiPropertyOptional({ description: 'SHA-256 hash of this audit entry' })
  hash?: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** An audit log export. */
export class AuditExportDto {
  @ApiProperty({ description: 'Format of the export', enum: ['csv', 'json'], example: 'json' })
  format!: string;

  @ApiProperty({ description: 'Number of exported entries', example: 120 })
  count!: number;

  @ApiPropertyOptional({ description: 'Cursor of the next page, null when the export is complete' })
  nextCursor?: string | null;

  @ApiProperty({ description: 'The exported entries (or the CSV document)' })
  data!: unknown;
}

/** The result of an audit log integrity verification. */
export class AuditIntegrityDto {
  @ApiProperty({ description: 'Whether the hash chain is intact', example: true })
  valid!: boolean;

  @ApiProperty({ description: 'Number of hashed entries that were checked', example: 120 })
  totalChecked!: number;

  @ApiPropertyOptional({ description: 'Id of the first entry that broke the chain' })
  brokenAtEntryId?: string | null;

  @ApiPropertyOptional({ description: 'Zero-based index of the first broken entry' })
  brokenAtIndex?: number | null;

  @ApiProperty({ description: 'Integrity verification result', example: 'Chain integrity verified' })
  message!: string;
}

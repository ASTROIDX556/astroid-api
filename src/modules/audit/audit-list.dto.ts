import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isValidAuditCursor } from './audit-cursor';

export const auditListQuerySchema = z
  .object({
    cursor: z.string().max(256).refine(isValidAuditCursor, 'Invalid cursor').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    actorId: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(120).optional(),
    resourceId: z.string().min(1).max(128).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '`to` must be greater than or equal to `from`',
      });
    }
  });

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
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

  @ApiProperty({ description: 'Number of entries that were checked', example: 120 })
  entriesChecked!: number;

  @ApiPropertyOptional({ description: 'Id of the first entry that broke the chain' })
  brokenAt?: string;

  @ApiPropertyOptional({ description: 'Explanation of the failure' })
  reason?: string;
}

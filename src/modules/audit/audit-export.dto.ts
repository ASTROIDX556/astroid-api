import { z } from 'zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const exportAuditLogsQuerySchema = z.object({
  agentId: z.string().optional(),
  userId: z.string().optional(),
  actionType: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
  cursor: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

export type ExportAuditLogsQuery = z.infer<typeof exportAuditLogsQuerySchema>;

/** Swagger model mirroring {@link ExportAuditLogsQuery}. */
export class ExportAuditLogsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by agent UUID' })
  agentId?: string;

  @ApiPropertyOptional({ description: 'Filter by user UUID' })
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter by audit action type', example: 'wallet.created' })
  actionType?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 start of the export window', example: '2026-01-01T00:00:00.000Z' })
  startDate?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 end of the export window', example: '2026-12-31T23:59:59.000Z' })
  endDate?: string;

  @ApiPropertyOptional({ description: 'Maximum entries to export (max 1000)', default: 100, example: 100 })
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor from a previous page' })
  cursor?: string;

  @ApiPropertyOptional({ enum: ['json', 'csv'], description: 'Export format (default json)', default: 'json' })
  format?: 'json' | 'csv';
}

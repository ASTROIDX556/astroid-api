import { z } from 'zod';

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

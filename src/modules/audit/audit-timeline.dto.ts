import { z } from 'zod';
import { AUDIT_DEFAULT_PAGE_SIZE, AUDIT_MAX_PAGE_SIZE } from './audit-list.dto';
import { isValidAuditCursor } from './audit-cursor';

/** Path parameter of the resource timeline endpoint. */
export const auditResourceIdParamSchema = z.string().min(1).max(128);

/** Query accepted by the ascending per-resource audit timeline. */
export const auditTimelineQuerySchema = z
  .object({
    cursor: z.string().max(256).refine(isValidAuditCursor, 'Invalid cursor').optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE).optional(),
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
  })
  .transform((query) => ({
    ...query,
    limit: query.limit ?? AUDIT_DEFAULT_PAGE_SIZE,
  }));

export type AuditTimelineQuery = z.infer<typeof auditTimelineQuerySchema>;

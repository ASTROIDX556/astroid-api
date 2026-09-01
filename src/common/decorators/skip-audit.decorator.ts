import { SetMetadata } from '@nestjs/common';

export const IS_SKIP_AUDIT_KEY = 'astroid:skipAudit';

/** Excludes a route from the global AuditInterceptor. */
export const SkipAudit = () => SetMetadata(IS_SKIP_AUDIT_KEY, true);

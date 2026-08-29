import { SetMetadata } from '@nestjs/common';

export const AUDIT_LOG_KEY = 'astroid:auditLog';

export interface AuditLogOptions {
  action: string;
  entity?: string;
  entityIdParam?: string;
}

export const Audit = (options: AuditLogOptions) => SetMetadata(AUDIT_LOG_KEY, options);
export const AuditLog = Audit;

import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../modules/audit/audit.service';
import { AUDIT_LOG_KEY, AuditLogOptions } from '../decorators/audit-log.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

const SENSITIVE_KEYS = new Set(['password', 'secret', 'privatekey', 'apikey', 'api_key']);

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(private readonly reflector: Reflector, private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<AuditLogOptions>(AUDIT_LOG_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return next.handle();
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();
    const persist = (status: number): void => {
      const user = request.user;
      if (!user?.organizationId) return;
      const entityId = options.entityIdParam ? request.params?.[options.entityIdParam] : undefined;
      setTimeout(() => {
        void this.auditService.record({
          organizationId: user.organizationId,
          userId: user.id,
          action: options.action,
          entity: options.entity ?? context.getClass().name,
          entityId: typeof entityId === 'string' ? entityId : null,
          newValue: sanitize({ body: sanitize(request.body), status, durationMs: Date.now() - startedAt }) as Prisma.InputJsonValue,
          ipAddress: null,
          device: undefined,
        }).catch((error: unknown) => this.logger.error(`Failed to persist request audit: ${(error as Error).message}`));
      }, 0);
    };
    return next.handle().pipe(
      tap(() => persist(response.statusCode)),
      catchError((error: unknown) => {
        persist(typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500);
        return throwError(() => error);
      }),
    );
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitize(entry)]));
}

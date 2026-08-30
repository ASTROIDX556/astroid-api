import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { AuditService } from '../../modules/audit/audit.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { IS_SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator';
import { TraceContext } from '../context/trace.context';

/**
 * Fields that must never appear in audit-logged request bodies.
 * Scrubbed recursively from any object or nested structure.
 */
const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordhash',
  'secret',
  'secretkey',
  'privatekey',
  'private_key',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'token',
  'apikey',
  'api_key',
  'hashedkey',
  'hashed_key',
  'webhooksecret',
  'webhook_secret',
  'hmacsecret',
  'hmac_secret',
  'x-api-key',
  'authorization',
]);

/**
 * NestJS interceptor that automatically persists an immutable audit-log record
 * for every state-mutating HTTP request (POST, PUT, PATCH, DELETE).
 *
 * Captures:
 *   - IP address and user-agent
 *   - Authenticated user / agent identity
 *   - HTTP method, URL, and sanitized request body
 *   - Response status code
 *   - The request's trace/correlation id, read from the `TraceContext`
 *     AsyncLocalStorage populated upstream by `AgentTraceInterceptor`
 *
 * The logged `action` defaults to `METHOD /url`, but a handler decorated
 * with `@AuditAction('TRANSFER_FUNDS')` overrides it with a semantic name.
 *
 * Routes decorated with @SkipAudit() are excluded.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skipAudit = this.reflector.getAllAndOverride<boolean>(IS_SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipAudit) {
      return next.handle();
    }

    const customAction = this.reflector.getAllAndOverride<string | undefined>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const res = http.getResponse<Response>();

    const { method, originalUrl, body, headers } = req;
    const ipAddress = this.extractIpAddress(req, headers);
    const userAgent = (headers['user-agent'] as string) ?? null;
    const userId = req.user?.id ?? null;
    const organizationId = req.user?.organizationId ?? null;
    const requestId = TraceContext.getTraceId() ?? null;

    const sanitizedBody = this.sanitize(body);

    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Date.now() - startTime;
          this.persistAuditLog({
            organizationId,
            userId,
            action: customAction,
            method,
            url: originalUrl,
            statusCode: res.statusCode,
            ipAddress,
            userAgent,
            requestId,
            body: sanitizedBody,
            durationMs,
          }).catch((err) => {
            this.logger.error(
              `Failed to persist audit log for ${method} ${originalUrl}: ${(err as Error).message}`,
            );
          });
        },
        error: () => {
          const durationMs = Date.now() - startTime;
          this.persistAuditLog({
            organizationId,
            userId,
            action: customAction,
            method,
            url: originalUrl,
            statusCode: res.statusCode,
            ipAddress,
            userAgent,
            requestId,
            body: sanitizedBody,
            durationMs,
          }).catch((err) => {
            this.logger.error(
              `Failed to persist audit log for ${method} ${originalUrl}: ${(err as Error).message}`,
            );
          });
        },
      }),
    );
  }

  private extractIpAddress(
    req: Request,
    headers: Record<string, unknown>,
  ): string | null {
    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim() ?? null;
    }
    return req.socket?.remoteAddress ?? null;
  }

  /**
   * Recursively removes sensitive fields from the request body before
   * persisting. Replaces values with `[REDACTED]` to preserve structure
   * without leaking secrets.
   */
  private sanitize(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitize(item));
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitize(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  private async persistAuditLog(data: {
    organizationId: string | null;
    userId: string | null;
    action: string | undefined;
    method: string;
    url: string;
    statusCode: number;
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string | null;
    body: unknown;
    durationMs: number;
  }): Promise<void> {
    if (!data.organizationId) {
      return;
    }

    await this.auditService.record({
      organizationId: data.organizationId,
      userId: data.userId,
      action: data.action ?? `${data.method} ${data.url}`,
      entity: 'http',
      entityId: null,
      newValue: {
        method: data.method,
        url: data.url,
        statusCode: data.statusCode,
        body: data.body,
        durationMs: data.durationMs,
      } as object,
      ipAddress: data.ipAddress,
      device: data.userAgent,
      requestId: data.requestId,
    });
  }
}

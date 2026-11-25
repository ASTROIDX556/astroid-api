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
import { AUDIT_ACTION_KEY, normalizeAuditAction } from '../decorators/audit-action.decorator';
import { TraceContext } from '../context/trace.context';
import { sanitizeAuditPayload } from '../helpers/audit-sanitizer';

/**
 * Metadata keys silently omitted from the recorded audit payload because they
 * add noise rather than forensic value (the trace id is stored on its own
 * column and the actor is already captured as `userId`).
 */
const EXCLUDED_META_KEYS = new Set(['password', 'token', 'authorization', 'x-api-key']);

/**
 * NestJS interceptor that automatically persists an immutable audit-log record
 * for every request (POST, PUT, PATCH, DELETE).
 *
 * Captures:
 *   - IP address and user-agent
 *   - Authenticated user / agent identity
 *   - HTTP method, URL, and sanitized request body
 *   - Response status code
 *   - The request's trace/correlation id, read from the `TraceContext`
 *     AsyncLocalStorage populated upstream by `AgentTraceInterceptor`
 *
 * Routes decorated with @SkipAudit() are excluded.
 *
 * Routes marked with `@AuditAction()` are owned by the
 * `StructuredAuditInterceptor`, which publishes the audit record on the
 * internal event bus instead of writing it inline. Skipping them here keeps
 * exactly one audit row per operation.
 */

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];

    const skipAudit = this.reflector.getAllAndOverride<boolean>(IS_SKIP_AUDIT_KEY, targets);

    if (skipAudit) {
      return next.handle();
    }

    // Routes that declare a semantic audit action are audited through the
    // event bus by the StructuredAuditInterceptor.
    const structuredAction = normalizeAuditAction(
      this.reflector.getAllAndOverride<unknown>(AUDIT_ACTION_KEY, targets),
    );
    if (structuredAction) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const res = http.getResponse<Response>();

    const { method, originalUrl, body, headers, params, query } = req;
    const ipAddress = this.extractIpAddress(req, headers);
    const userAgent = (headers['user-agent'] as string) ?? null;
    const userId = req.user?.id ?? null;
    const organizationId = req.user?.organizationId ?? null;
    const requestId = TraceContext.getTraceId() ?? null;
    const agentId = TraceContext.getAgentId() ?? null;

    const sanitizedBody = sanitizeAuditPayload(body);
    const sanitizedParams = sanitizeAuditPayload(params);
    const sanitizedQuery = sanitizeAuditPayload(this.stripSensitiveKeys(query));

    const startTime = Date.now();

    const recordLog = () => {
      const durationMs = Date.now() - startTime;
      const action = `${method} ${originalUrl}`;
      this.persistAuditLog({
        organizationId,
        userId,
        agentId,
        action,
        method,
        url: originalUrl,
        statusCode: res.statusCode,
        ipAddress,
        userAgent,
        requestId,
        body: sanitizedBody,
        params: sanitizedParams,
        query: sanitizedQuery,
        durationMs,
      }).catch((err) => {
            this.logger.error(
              `Failed to persist audit log for ${method} ${originalUrl}: ${(err as Error).message}`,
            );
          });
    };

    return next.handle().pipe(
      tap({
        next: () => recordLog(),
        error: () => recordLog(),
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
   * Removes top-level keys that carry no audit value (authorization headers,
   * tokens) from the URL query string before it is stored.
   */
  private stripSensitiveKeys(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }
    if (typeof data !== 'object') {
      return data;
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!EXCLUDED_META_KEYS.has(key.toLowerCase())) {
        output[key] = value;
      }
    }
    return output;
  }

  private async persistAuditLog(data: {
    organizationId: string | null;
    userId: string | null;
    agentId: string | null;
    action: string;
    method: string;
    url: string;
    statusCode: number;
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string | null;
    body: unknown;
    params?: unknown;
    query?: unknown;
    durationMs: number;
  }): Promise<void> {
    if (!data.organizationId) {
      return;
    }

    await this.auditService.record({
      organizationId: data.organizationId,
      userId: data.userId,
      action: data.action,
      entity: 'http',
      entityId: null,
      newValue: {
        method: data.method,
        url: data.url,
        statusCode: data.statusCode,
        body: data.body,
        params: data.params,
        query: data.query,
        agentId: data.agentId,
        durationMs: data.durationMs,
      } as object,
      ipAddress: data.ipAddress,
      device: data.userAgent,
      requestId: data.requestId,
    });
  }
}

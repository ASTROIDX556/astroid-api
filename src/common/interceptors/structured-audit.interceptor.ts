import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { AuditRecordedPayload } from '../../events/domain-event.types';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import {
  AUDIT_ACTION_KEY,
  AuditActionOptions,
  normalizeAuditAction,
} from '../decorators/audit-action.decorator';
import { IS_SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import { TraceContext } from '../context/trace.context';
import { sanitizeAuditPayload } from '../helpers/audit-sanitizer';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Request metadata that is captured for every audited operation.
 */
interface AuditCapture {
  context: ExecutionContext;
  request: Request & { user?: AuthenticatedUser };
  response: Response;
  auditAction: AuditActionOptions;
  startedAt: number;
  error?: unknown;
}

/**
 * Structured audit interceptor for sensitive API endpoints.
 *
 * Only routes explicitly marked with `@AuditAction()` are audited, which keeps
 * the compliance trail focused on the operations that matter (key rotation,
 * budget adjustments, policy updates, transfers, …) instead of every request.
 *
 * For a marked route the interceptor captures:
 *   - the request metadata: HTTP method, path, sanitized body, params, query
 *   - the actor: the authenticated user id and, for agent-driven calls, the
 *     acting agent id
 *   - the client IP address and user agent
 *   - the timestamp of the operation and the final response status code
 *   - the handler duration
 *
 * The record is published as an `audit.recorded` event on the internal event
 * bus (`@nestjs/event-emitter` via {@link EventBusService}) and the
 * publication is **not** awaited: the response cycle is never blocked by the
 * audit pipeline. The `AuditRecordedListener` in the audit module turns the
 * event into the immutable audit-log row.
 *
 * Sensitive material never reaches the event: request payloads are run through
 * the shared audit sanitizer, which redacts private keys, secrets, API keys,
 * bearer tokens and JWTs before the record is built.
 */
@Injectable()
export class StructuredAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(StructuredAuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly eventBus: EventBusService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];

    const auditAction = normalizeAuditAction(
      this.reflector.getAllAndOverride<unknown>(AUDIT_ACTION_KEY, targets),
    );

    // Selective auditing: unmarked routes are passed straight through.
    if (!auditAction) {
      return next.handle();
    }

    // An explicit @SkipAudit() always wins over @AuditAction().
    if (this.reflector.getAllAndOverride<boolean>(IS_SKIP_AUDIT_KEY, targets) === true) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();

    const publish = (error?: unknown) => {
      try {
        this.publishAuditEvent({
          context,
          request,
          response,
          auditAction,
          startedAt,
          error,
        });
      } catch (publishError) {
        this.logger.error(
          `Failed to publish audit event for ${auditAction.action}: ${(publishError as Error).message}`,
        );
      }
    };

    return next.handle().pipe(
      tap({
        next: () => publish(),
        error: (error: unknown) => publish(error),
      }),
    );
  }

  /**
   * Builds the audit payload and hands it to the event bus. The promise is
   * deliberately not awaited: the audit trail must never delay the response.
   */
  private publishAuditEvent(capture: AuditCapture): void {
    const { context, request, auditAction } = capture;

    const organizationId =
      request.user?.organizationId ??
      TraceContext.getOrganizationId() ??
      (request.params?.organizationId as string | undefined) ??
      null;

    if (!organizationId) {
      this.logger.warn(
        `Skipping audit event for ${auditAction.action}: the request carries no organization context`,
      );
      return;
    }

    const payload = this.buildPayload(capture);
    payload.organizationId = organizationId;
    const entity = auditAction.entity ?? this.resolveEntity(context);
    const entityId = payload.entityId ?? undefined;

    void this.eventBus
      .emit(DomainEventName.AuditRecorded, payload, {
        organizationId,
        actorId: payload.userId ?? undefined,
        aggregateType: entity,
        aggregateId: entityId,
        requestId: payload.requestId ?? undefined,
      })
      .catch((emitError: unknown) => {
        this.logger.error(
          `Failed to dispatch audit event for ${auditAction.action}: ${(emitError as Error).message}`,
        );
      });
  }

  /** Builds the sanitized audit payload for a captured request. */
  private buildPayload(capture: AuditCapture): AuditRecordedPayload {
    const { request, response, auditAction, startedAt, error } = capture;

    const statusCode = this.resolveStatusCode(response, error);
    const userAgent = (request.headers['user-agent'] as string | undefined) ?? null;

    return {
      action: auditAction.action,
      ...(auditAction.entity ? { entity: auditAction.entity } : {}),
      entityId: (request.params?.id as string | undefined) ?? null,
      ...(auditAction.description ? { description: auditAction.description } : {}),
      method: request.method,
      url: request.path ?? request.originalUrl ?? request.url,
      statusCode,
      success: error === undefined && statusCode < 400,
      userId: request.user?.id ?? null,
      agentId: TraceContext.getAgentId() ?? null,
      ipAddress: this.resolveIpAddress(request),
      userAgent,
      requestId: TraceContext.getTraceId() ?? null,
      traceId: TraceContext.getTraceId() ?? null,
      durationMs: Date.now() - startedAt,
      occurredAt: new Date().toISOString(),
      body: sanitizeAuditPayload(request.body),
      params: sanitizeAuditPayload(request.params),
      query: sanitizeAuditPayload(request.query),
    };
  }

  /**
   * Resolves the status code to record. On success the response carries the
   * real code; on failure the exception's HTTP status is used, because the
   * global exception filter only sets it after the interceptor chain unwinds.
   */
  private resolveStatusCode(response: Response, error?: unknown): number {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    return response?.statusCode ?? 200;
  }

  /** Resolves the client IP, honouring the first entry of `x-forwarded-for`. */
  private resolveIpAddress(request: Request): string | null {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim() ?? null;
    }
    return request.ip ?? request.socket?.remoteAddress ?? null;
  }

  /** Derives a domain entity name from the controller, e.g. `PolicyController` -> `Policy`. */
  private resolveEntity(context: ExecutionContext): string {
    const controllerName = context.getClass()?.name;
    return controllerName ? controllerName.replace(/Controller$/, '') : 'Request';
  }
}

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

import { AuditService } from '../../modules/audit/audit.service';
import { CreateAuditLogData } from '../../modules/audit/audit.repository';
import { getClientIp } from '../../utils/ip.util';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/** HTTP methods whose state-mutating requests are audited. Read-only traffic is skipped. */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Value substituted for sensitive fields before an audit payload is persisted. */
export const REDACTED_VALUE = '[REDACTED]';

/**
 * Field-name fragments (case-insensitive) considered sensitive. Matching is
 * intentionally broad so credentials never leak into the audit trail, in line
 * with the SECURITY.md redaction policy.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passphrase',
  'passkey',
  'token',
  'secret',
  'signature',
  'apikey',
  'privatekey',
  'authorization',
];

/** Returns true when a field name denotes sensitive data (e.g. `apiKey`, `accessToken`). */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Deeply masks sensitive fields in a JSON-shaped value, preserving everything
 * else. Never mutates the input: plain objects and arrays are rebuilt.
 */
export function maskSensitiveData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveData(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED_VALUE : maskSensitiveData(item);
    }
    return result as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Global audit interceptor. Persists a permanent, traceable record of every
 * state-mutating request (POST/PUT/PATCH/DELETE) into the existing PostgreSQL
 * audit trail through `AuditService`/Prisma.
 *
 * Captured per request:
 *   - authenticated user (or agent) identity
 *   - HTTP method, route path and client IP
 *   - the request body with sensitive fields masked
 *   - the final response status code
 *
 * The audit write happens once the response has been fully sent (`finish`), so
 * the recorded status code is the real one — including error statuses set by
 * the global exception filter. Persistence is fire-and-forget and failures are
 * logged but never crash the client request (no strict compliance mode exists
 * in this project, so non-blocking is the required behavior).
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();

    // Only state-mutating methods are audited; read-only traffic is skipped.
    if (!AUDITED_METHODS.has(request.method)) {
      return next.handle();
    }

    // Audit rows are scoped to an organization (required FK on AuditLog).
    const organizationId =
      request.user?.organizationId ||
      (request.params?.organizationId as string) ||
      (request.headers['x-organization-id'] as string) ||
      undefined;
    if (!organizationId) {
      return next.handle();
    }

    const userId = request.user?.id || (request.headers['x-user-id'] as string) || null;
    // Same agent-identity resolution chain as AgentTraceInterceptor.
    const agentId =
      (request.params?.agentId as string) ||
      (request.body?.agentId as string) ||
      (request.query?.agentId as string) ||
      (request.headers['x-agent-id'] as string) ||
      undefined;

    const trustProxy = this.config.get<boolean>('app.trustProxy', false);
    const ipAddress =
      getClientIp(request.ip ?? '', request.headers['x-forwarded-for'] as string, trustProxy) ||
      undefined;

    response.on('finish', () => {
      void this.persistAudit(
        this.buildAuditData(request, context, { organizationId, userId, agentId, ipAddress }, response.statusCode),
      );
    });

    return next.handle();
  }

  /** Builds the audit row, storing the masked body, path and agent id as `newValue`. */
  private buildAuditData(
    request: Request & { user?: AuthenticatedUser },
    context: ExecutionContext,
    identity: { organizationId: string; userId: string | null; agentId?: string; ipAddress?: string },
    statusCode: number,
  ): CreateAuditLogData {
    const body = request.body;
    const maskedBody = body && typeof body === 'object' ? maskSensitiveData(body) : undefined;

    const newValue: Prisma.InputJsonValue = {
      path: request.path,
      ...(maskedBody !== undefined ? { body: maskedBody } : {}),
      // Agent identity is stored here per the existing audit-export convention
      // (the schema has no dedicated agent column).
      ...(identity.agentId ? { agentId: identity.agentId } : {}),
      statusCode,
    };

    return {
      organizationId: identity.organizationId,
      userId: identity.userId,
      action: request.method,
      entity: this.resolveEntity(context),
      entityId: (request.params?.id as string) ?? null,
      newValue,
      ipAddress: identity.ipAddress,
      device: (request.headers['user-agent'] as string) ?? null,
    };
  }

  /** Derives a domain entity name from the controller, e.g. `PolicyController` -> `Policy`. */
  private resolveEntity(context: ExecutionContext): string {
    const controllerName = context.getClass()?.name;
    return controllerName ? controllerName.replace(/Controller$/, '') : 'Request';
  }

  /** Persists the audit row. Failures are logged but never break the client request. */
  private async persistAudit(data: CreateAuditLogData): Promise<void> {
    try {
      await this.auditService.record(data);
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for ${data.action} ${data.entity}: ${(error as Error).message}`,
      );
    }
  }
}

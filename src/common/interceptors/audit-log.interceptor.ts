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

    if (!AUDITED_METHODS.has(request.method)) {
      return next.handle();
    }

    const organizationId =
      request.user?.organizationId ||
      (request.params?.organizationId as string) ||
      (request.headers['x-organization-id'] as string) ||
      undefined;
    if (!organizationId) {
      return next.handle();
    }

    const userId = request.user?.id || (request.headers['x-user-id'] as string) || null;
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

    const startedAt = Date.now();

    response.on('finish', () => {
      void this.persistAudit(
        this.buildAuditData(
          request,
          context,
          { organizationId, userId, agentId, ipAddress },
          response.statusCode,
          Date.now() - startedAt,
        ),
      );
    });

    return next.handle();
  }

  private buildAuditData(
    request: Request & { user?: AuthenticatedUser },
    context: ExecutionContext,
    identity: { organizationId: string; userId: string | null; agentId?: string; ipAddress?: string },
    statusCode: number,
    durationMs: number,
  ): CreateAuditLogData {
    const body = request.body;
    const maskedBody = body && typeof body === 'object' ? maskSensitiveData(body) : undefined;

    const newValue: Prisma.InputJsonValue = {
      path: request.path,
      ...(maskedBody !== undefined ? { body: maskedBody } : {}),
      ...(identity.agentId ? { agentId: identity.agentId } : {}),
      statusCode,
      durationMs,
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

  private resolveEntity(context: ExecutionContext): string {
    const controllerName = context.getClass()?.name;
    return controllerName ? controllerName.replace(/Controller$/, '') : 'Request';
  }

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

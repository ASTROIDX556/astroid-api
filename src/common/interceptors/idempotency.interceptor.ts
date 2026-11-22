import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable, from, of } from 'rxjs';
import { lastValueFrom } from 'rxjs';

import { REQUEST_ID_HEADER } from '../constants/headers';
import { IDEMPOTENT_KEY, IdempotentOptions } from '../decorators/idempotent.decorator';
import { IdempotencyService } from '../idempotency/idempotency.service';
import {
  IdempotencyInFlightError,
  IdempotencyMismatchError,
} from '../idempotency/idempotency.types';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * HTTP adapter for the shared {@link IdempotencyService}.
 *
 * Honoured only on handlers decorated with `@Idempotent()`, so existing routes
 * keep their exact behaviour. Requests without an `Idempotency-Key` bypass the
 * mechanism entirely.
 *
 * Responses:
 * - **409 + Retry-After** when a duplicate arrives while the original runs.
 * - **409** when the key was already used with a different request body.
 * - The original status, body and request id on replay.
 *
 * Streaming and multipart/file-upload requests are deliberately excluded:
 * buffering their bodies for hashing (and replaying their streams) is not
 * safe, so they always execute normally.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { id?: string } }>();
    const response = http.getResponse<Response>();

    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key) return next.handle();

    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException(
        'Idempotency-Key must contain 1 to 128 ASCII letters, digits, dots, underscores, tildes, or hyphens',
      );
    }

    if (!isReplayableJsonRequest(request)) return next.handle();

    const principalId = request.user?.id;
    if (!principalId) {
      // The routes that opt in are authenticated; without a principal the key
      // cannot be scoped, so fall back to normal execution rather than sharing
      // a namespace between callers.
      return next.handle();
    }

    const route = `${request.method} ${request.baseUrl ?? ''}${request.path}`;

    let handle: Awaited<ReturnType<IdempotencyService['begin']>>;
    try {
      handle = await this.idempotency.begin({
        principalId,
        route,
        key,
        requestBody: request.body,
      });
    } catch (error) {
      if (error instanceof IdempotencyInFlightError) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw toHttpException(error);
    }

    if (handle.replay) {
      response.status(handle.replay.statusCode);
      if (handle.replay.requestId) {
        // Preserve the original request id in the envelope and on the wire.
        request.headers[REQUEST_ID_HEADER] = handle.replay.requestId;
        response.setHeader(REQUEST_ID_HEADER, handle.replay.requestId);
      }
      return of(handle.replay.body);
    }

    const statusCode = this.resolveStatusCode(context, request, response);
    return from(this.execute(next, handle, response, statusCode));
  }

  /**
   * The status Nest will send. Router-level defaults (201 for POST) are applied
   * after the interceptor chain, so they are derived here from the handler
   * metadata and the HTTP method instead of reading `response.statusCode`.
   */
  private resolveStatusCode(
    context: ExecutionContext,
    request: Request,
    response: Response,
  ): number {
    const explicit = this.reflector.getAllAndOverride<number | undefined>(HTTP_CODE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (explicit) return explicit;
    if (response.statusCode && response.statusCode !== 200) return response.statusCode;
    return request.method === 'POST' ? 201 : response.statusCode || 200;
  }

  private async execute(
    next: CallHandler,
    handle: Awaited<ReturnType<IdempotencyService['begin']>>,
    response: Response,
    statusCode: number,
  ): Promise<unknown> {
    try {
      const body = await lastValueFrom(next.handle());
      await handle.complete({
        statusCode,
        body,
        requestId:
          (response.getHeader(REQUEST_ID_HEADER) as string | undefined) ??
          null,
      });
      return body;
    } catch (error) {
      // Release the reservation so a client may retry after a failed request,
      // including a 5xx that rolled nothing back.
      await handle.fail();
      throw error;
    }
  }
}

/** True only for JSON bodies we can hash and replay safely. */
function isReplayableJsonRequest(request: Request): boolean {
  if (request.is?.('multipart/form-data')) return false;
  const body: unknown = request.body;
  if (body === undefined || body === null) return true;
  return typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body);
}

function toHttpException(error: unknown): Error {
  if (error instanceof IdempotencyMismatchError) {
    return new ConflictException(error.message);
  }
  if (error instanceof IdempotencyInFlightError) {
    return new ConflictException(error.message);
  }
  return error instanceof Error ? error : new Error('Idempotency check failed');
}

/**
 * Tenant-scoped actor. API-key requests are scoped by the API key itself so
 * two keys belonging to the same user do not share replay records; JWT
 * requests are scoped by the authenticated user.
 */
function resolvePrincipal(user: AuthenticatedUser | undefined): string {
  const organizationId = user?.organizationId ?? 'anonymous';
  const actorId = user?.isApiKey
    ? user.apiKeyId ?? user.id
    : user?.id ?? user?.sub ?? 'anonymous';
  return `${organizationId}:${actorId}`;
}

/** Round-trips through JSON so Prisma can persist dates/decimals safely. */
function serialisable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

function fromPromise<T>(promise: Promise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    promise.then(
      (value) => {
        subscriber.next(value);
        subscriber.complete();
      },
      (error: unknown) => subscriber.error(error),
    );
  });
}

function waitForNextPoll(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

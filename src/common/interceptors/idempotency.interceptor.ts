import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable, from, of } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import type { ZodTypeAny } from 'zod';

import { ErrorCode } from '../constants/error-codes';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  REQUEST_ID_HEADER,
} from '../constants/headers';
import { DomainException } from '../exceptions/domain.exception';
import { IDEMPOTENT_KEY, IdempotentOptions } from '../decorators/idempotent.decorator';
import { IdempotencyService } from '../idempotency/idempotency.service';
import {
  IdempotencyInFlightError,
  IdempotencyMismatchError,
} from '../idempotency/idempotency.types';
import { idempotencyConfig, IdempotencyConfig } from '../../config/idempotency.config';

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 255;

/**
 * HTTP adapter for the shared {@link IdempotencyService}.
 *
 * Honoured only on handlers decorated with `@Idempotent()`, so existing routes
 * keep their exact behaviour. Requests without an `Idempotency-Key` bypass the
 * mechanism entirely.
 *
 * Responses:
 * - **409 + Retry-After** when a duplicate arrives while the original runs.
 * - **422** when the key was already used with a different request body.
 * - The original status, body and request id on replay, plus
 *   `Idempotency-Replayed: true`.
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
    @Optional() private readonly config?: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { id?: string; isApiKey?: boolean; apiKeyId?: string } }>();
    const response = http.getResponse<Response>();

    const settings = this.settings();
    const rawKey = request.headers[settings.headerName.toLowerCase()];
    if (rawKey === undefined) return next.handle();

    const key = Array.isArray(rawKey) ? rawKey[0]?.trim() : rawKey.trim();
    if (!key || key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `${settings.headerName} must be 8 to 255 characters after trimming whitespace`,
      );
    }

    if (!isReplayableJsonRequest(request)) return next.handle();

    const user = request.user;
    if (!user?.id) {
      // The routes that opt in are authenticated; without a principal the key
      // cannot be scoped, so fall back to normal execution rather than sharing
      // a namespace between callers.
      return next.handle();
    }

    const scope = user.isApiKey ? `apikey:${user.apiKeyId ?? user.id}` : `user:${user.id}`;
    const route = `${request.method} ${request.baseUrl ?? ''}${request.path}`;

    let handle: Awaited<ReturnType<IdempotencyService['begin']>>;
    try {
      handle = await this.idempotency.begin({
        principalId: user.id,
        scope,
        route,
        key,
        requestBody: normalizedBody(options.bodySchema, request.body),
      });
    } catch (error) {
      if (error instanceof IdempotencyInFlightError) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw toHttpException(error);
    }

    if (handle.replay) {
      response.status(handle.replay.statusCode);
      response.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
      response.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      if (handle.replay.requestId) {
        // Preserve the original request id in the envelope and on the wire.
        request.headers[REQUEST_ID_HEADER] = handle.replay.requestId;
        response.setHeader(REQUEST_ID_HEADER, handle.replay.requestId);
      }
      // The global response interceptor reads replay metadata from the request
      // context before this interceptor runs, so publish it there as well.
      return of(this.idempotency.replay<unknown>(handle.replay));
    }

    const statusCode = this.resolveStatusCode(context, request, response);
    return from(this.execute(next, handle, response, statusCode, request));
  }

  private settings(): IdempotencyConfig {
    return this.config?.get<IdempotencyConfig>('idempotency') ?? idempotencyConfig();
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
    request: Request,
  ): Promise<unknown> {
    try {
      const body = await lastValueFrom(next.handle());
      await handle.complete({
        statusCode,
        body,
        requestId:
          (response.getHeader(REQUEST_ID_HEADER) as string | undefined) ??
          (request.headers[REQUEST_ID_HEADER] as string | undefined) ??
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

/**
 * Uses the route's Zod schema when present so defaults and normalization are
 * applied before hashing. A schema mismatch is left to the validation pipe:
 * the raw body is hashed only long enough for that pipe to reject the request
 * and release the reservation.
 */
function normalizedBody(schema: ZodTypeAny | undefined, body: unknown): unknown {
  if (!schema) return body;
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : body;
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
    return new DomainException(ErrorCode.IDEMPOTENCY_KEY_MISMATCH, error.message);
  }
  if (error instanceof IdempotencyInFlightError) {
    return new DomainException(ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT, error.message);
  }
  return error instanceof Error ? error : new Error('Idempotency check failed');
}

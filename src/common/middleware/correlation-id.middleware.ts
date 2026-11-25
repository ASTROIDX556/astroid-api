import { randomUUID } from 'crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../constants/headers';

/**
 * Accepted shape of an inbound correlation id. Deliberately narrow: no control
 * characters or whitespace (which would allow log injection) and a length cap so
 * a client cannot flood every log line of the request.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Returns the trimmed id when it is a well-formed header value, otherwise
 * `undefined` so the caller generates a fresh one.
 */
export function sanitizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Seeds the correlation identifiers for every inbound request.
 *
 * - `X-Request-Id` is preserved when well-formed and generated (UUID) otherwise.
 * - `X-Correlation-Id` falls back to the request id, so every request has one
 *   even when the caller only sent a request id.
 * - Both are written back onto `request.headers` for downstream interceptors,
 *   the structured logger and queue producers, and echoed on the response.
 *
 * A malformed value is never rejected — the request proceeds with a freshly
 * generated id — so tracing stays available without changing status codes.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId =
      sanitizeCorrelationId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
    const correlationId =
      sanitizeCorrelationId(req.headers[CORRELATION_ID_HEADER]) ?? requestId;

    req.headers[REQUEST_ID_HEADER] = requestId;
    req.headers[CORRELATION_ID_HEADER] = correlationId;

    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}

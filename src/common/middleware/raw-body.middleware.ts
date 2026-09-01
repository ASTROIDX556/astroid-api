import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * Captures the raw request body as a Buffer before Express parses it as JSON.
 *
 * Webhook signature verification (HMAC-SHA256) requires the exact bytes that
 * were signed by the sender. If Express's `express.json()` parser runs first,
 * the body is re-serialized via `JSON.stringify`, which can change key ordering,
 * whitespace, and Unicode encoding — invalidating the signature.
 *
 * This middleware stores the raw body on `request.rawBody` so the
 * `WebhookSignatureGuard` can use it for HMAC computation.
 *
 * Apply this middleware ONLY to webhook ingress routes (e.g. `/webhooks/receive`)
 * to avoid buffering every request in the application.
 */
@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    // Buffer is only needed for POST/PUT/PATCH; skip others.
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      next();
      return;
    }

    // If express.json() has already consumed the stream, the body is on req.body.
    // In that case, re-serialize to get a Buffer the guard can use.
    if (req.body !== undefined && req.rawBody === undefined) {
      const raw =
        typeof req.body === 'string'
          ? Buffer.from(req.body)
          : Buffer.from(JSON.stringify(req.body));
      req.rawBody = raw;
      next();
      return;
    }

    // Capture the raw request body by buffering the incoming data stream.
    // This must run BEFORE express.json() so we intercept the bytes first.
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
    });

    next();
  }
}


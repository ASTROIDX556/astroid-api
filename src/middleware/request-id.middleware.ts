import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../common/constants/headers';

/**
 * Ensures every request carries a stable `x-request-id` (generating one when
 * absent) and echoes it back on the response. Also seeds a correlation id used
 * for tracing a request across queue workers and events.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const existing = req.headers[REQUEST_ID_HEADER] as string | undefined;
    const requestId = existing && existing.length > 0 ? existing : `req_${uuidv7()}`;
    req.headers[REQUEST_ID_HEADER] = requestId;

    const correlation = req.headers[CORRELATION_ID_HEADER] as string | undefined;
    req.headers[CORRELATION_ID_HEADER] = correlation && correlation.length > 0 ? correlation : requestId;

    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}

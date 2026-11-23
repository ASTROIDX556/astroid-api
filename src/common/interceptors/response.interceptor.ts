import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ApiSuccessResponse,
  CursorPaginated,
  Paginated,
} from '../interfaces/api-response.interface';
import { REQUEST_ID_HEADER, TOTAL_COUNT_HEADER } from '../constants/headers';
import { RequestContext } from '../context/request-context';
import {
  IDEMPOTENT_REPLAY,
  IDEMPOTENT_REPLAY_REQUEST_ID,
  IDEMPOTENT_REPLAY_STATUS,
} from '../idempotency/idempotency.constants';

/**
 * Wraps every successful controller return value in the canonical success
 * envelope. If a handler returns a `Paginated<T>`, its items become `data`, its
 * pagination info becomes `meta`, and the total row count is also exposed via
 * the `X-Total-Count` header for clients that page from headers.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<unknown>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    return next.handle().pipe(
      map((payload): ApiSuccessResponse<unknown> => {
        // Read replay metadata when the value is emitted: an idempotent replay
        // publishes the original request id and status from inside the handler
        // chain, plus a marker so clients can distinguish a replayed response.
        const requestId =
          RequestContext.getData<string>(IDEMPOTENT_REPLAY_REQUEST_ID) ??
          (request.headers[REQUEST_ID_HEADER] as string) ??
          'unknown';
        const replayStatus = RequestContext.getData<number>(IDEMPOTENT_REPLAY_STATUS);
        const isReplay = RequestContext.getData<boolean>(IDEMPOTENT_REPLAY);
        if (replayStatus) {
          http.getResponse<Response>().status(replayStatus);
        }
        const replayMeta = isReplay ? { idempotentReplay: true } : {};
        if (payload instanceof Paginated) {
          http.getResponse<Response>().setHeader(TOTAL_COUNT_HEADER, String(payload.meta.total));
          return {
            success: true,
            data: payload.items,
            meta: { ...payload.meta, ...replayMeta },
            requestId,
          };
        }
        if (payload instanceof CursorPaginated) {
          return {
            success: true,
            data: payload.items,
            meta: { ...payload.meta, ...replayMeta },
            requestId,
          };
        }
        return { success: true, data: payload ?? null, meta: replayMeta, requestId };
      }),
    );
  }
}

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { v7 as uuidv7 } from 'uuid';
import { Request } from 'express';
import { TraceContext, TraceContextData } from '../context/trace.context';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../constants/headers';

/**
 * Captures request tracing and AI agent transaction context, binding it to AsyncLocalStorage
 * during the request execution lifecycle for structured logging and downstream observability.
 */
@Injectable()
export class AgentTraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: AuthenticatedUser }>();

    const traceId =
      (req.headers[CORRELATION_ID_HEADER] as string) ||
      (req.headers[REQUEST_ID_HEADER] as string) ||
      uuidv7();

    const agentId =
      (req.params?.agentId as string) ||
      (req.body?.agentId as string) ||
      (req.query?.agentId as string) ||
      (req.headers['x-agent-id'] as string) ||
      undefined;

    const user = req.user;
    const organizationId =
      user?.organizationId ||
      (req.params?.organizationId as string) ||
      (req.headers['x-organization-id'] as string) ||
      undefined;

    const userId = user?.id || (req.headers['x-user-id'] as string) || undefined;

    const traceData: TraceContextData = {
      traceId,
      agentId,
      organizationId,
      userId,
      path: req.path,
      method: req.method,
    };

    return new Observable((subscriber) => {
      TraceContext.run(traceData, () => {
        next.handle().subscribe({
          next: (val) => subscriber.next(val),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}

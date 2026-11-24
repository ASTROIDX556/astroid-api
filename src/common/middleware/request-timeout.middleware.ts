import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

@Injectable()
export class RequestTimeoutMiddleware implements NestMiddleware {
  constructor(private readonly timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS) {}

  use(req: Request, res: Response, next: NextFunction): void {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: `Request exceeded maximum duration of ${this.timeoutMs}ms`,
            path: req.originalUrl ?? req.url,
          },
        });
      }
    }, this.timeoutMs);

    const clear = () => clearTimeout(timer);
    res.once('finish', clear);
    res.once('close', clear);

    Object.defineProperty(req, 'timedOut', {
      get: () => timedOut,
      configurable: true,
    });

    next();
  }
}

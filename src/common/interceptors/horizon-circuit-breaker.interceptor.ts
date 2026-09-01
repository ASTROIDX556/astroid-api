import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  HorizonCircuitBreakerService,
  FallbackStrategy,
  HorizonFallbackResponse,
} from '../../integrations/stellar/horizon-circuit-breaker.service';
import { CircuitOpenException } from '../exceptions/domain.exception';

/**
 * Metadata key for setting a custom fallback strategy on a controller method.
 * Usage: @SetMetadata(HORIZON_FALLBACK_KEY, myFallbackStrategy)
 */
export const HORIZON_FALLBACK_KEY = 'horizon_fallback';

/**
 * NestJS interceptor that routes Horizon-bound controller handler calls through
 * the {@link HorizonCircuitBreakerService}.
 *
 * When the circuit is OPEN and no fallback is registered, the interceptor
 * catches the {@link CircuitOpenException} and re-throws it, allowing the
 * global exception filter to produce the standard 503 error envelope.
 *
 * When a fallback strategy is registered (either globally via
 * `HorizonCircuitBreakerService.registerFallback()` or per-method via the
 * `HORIZON_FALLBACK_KEY` metadata), the fallback is invoked and its result
 * is returned instead of throwing.
 *
 * Usage:
 * ```ts
 * @UseInterceptors(HorizonCircuitBreakerInterceptor)
 * @Controller('stellar')
 * export class StellarController {
 *   constructor(private readonly cbService: HorizonCircuitBreakerService) {}
 *
 *   @Get('balances/:address')
 *   async getBalances(@Param('address') address: string) {
 *     return this.cbService.executeWithFallback(
 *       'getBalances',
 *       () => this.stellarService.getBalances(address, 'testnet'),
 *     );
 *   }
 * }
 * ```
 */
@Injectable()
export class HorizonCircuitBreakerInterceptor implements NestInterceptor {
  constructor(
    private readonly circuitBreakerService: HorizonCircuitBreakerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();

    // Check for per-method fallback strategy via metadata
    const methodFallback = Reflect.getMetadata(HORIZON_FALLBACK_KEY, handler) as
      | FallbackStrategy
      | undefined;

    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof CircuitOpenException) {
          // If a per-method fallback is defined, try it
          if (methodFallback) {
            return this.tryFallback(methodFallback);
          }
        }
        return throwError(() => error);
      }),
    );
  }

  /**
   * Attempts to execute a fallback strategy and wrap the result in a structured
   * fallback response. Returns an Observable with the fallback value.
   */
  private tryFallback(strategy: FallbackStrategy): Observable<unknown> {
    return new Observable((subscriber) => {
      Promise.resolve(strategy.execute())
        .then((result: unknown) => {
          const fallbackResponse: HorizonFallbackResponse = {
            isFallback: true,
            circuitName: this.circuitBreakerService.getName(),
            timestamp: Date.now(),
            retryAfterMs: 0,
            cachedData: result,
          };
          subscriber.next(fallbackResponse);
          subscriber.complete();
        })
        .catch((fallbackError: unknown) => {
          subscriber.error(fallbackError);
        });
    });
  }
}

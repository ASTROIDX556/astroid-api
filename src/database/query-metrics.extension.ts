import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';

const logger = new Logger('QueryMetrics');

export interface QueryMetricsOptions {
  /**
   * Queries that take longer than this threshold will emit a warn log.
   */
  slowQueryThresholdMs: number;
}

/**
 * Prisma client extension that records slow query warnings. Any query whose
 * duration exceeds `slowQueryThresholdMs` produces a structured warn log on
 * the `QueryMetrics` logger. The extension adds no latency on the hot path
 * other than measuring each operation.
 */
export function createQueryMetricsExtension(options: QueryMetricsOptions) {
  const { slowQueryThresholdMs } = options;

  return {
    query: {
      $allOperations({
        operation,
        model,
        args,
        query,
      }: {
        operation: string;
        model?: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        const startedAt = performance.now();

        const record = (durationMs: number) => {
          if (durationMs <= slowQueryThresholdMs) return;
          logger.warn(
            JSON.stringify({
              event: 'slow_query',
              operation,
              model,
              durationMs,
              thresholdMs: slowQueryThresholdMs,
            }),
          );
        };

        return (async () => {
          try {
            const result = await query(args);
            record(performance.now() - startedAt);
            return result;
          } catch (error) {
            record(performance.now() - startedAt);
            throw error;
          }
        })();
      },
    },
  };
}

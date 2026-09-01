import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface SlowQueryLoggerOptions {
  thresholdMs?: number;
  enabled?: boolean;
  logger?: Logger;
  onSlowQuery?: (report: SlowQueryReport) => void;
}

export interface SlowQueryReport {
  model?: string;
  action: string;
  durationMs: number;
  thresholdMs: number;
  args?: Record<string, unknown>;
  indexRecommendations?: string[];
  timestamp: string;
}

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /privatekey/i,
  /private_key/i,
  /seed/i,
  /passphrase/i,
  /auth/i,
  /signature/i,
  /hash/i,
];

/**
 * Recursively sanitizes query arguments to remove or mask sensitive parameters
 * before emitting them to log aggregators or console output.
 */
export function sanitizeQueryArgs(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 500 ? `${value.substring(0, 500)}...[TRUNCATED]` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeQueryArgs(item));
  }

  if (typeof value === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive) {
        sanitizedObj[key] = '[REDACTED]';
      } else {
        sanitizedObj[key] = sanitizeQueryArgs(val);
      }
    }
    return sanitizedObj;
  }

  return String(value);
}

/**
 * Analyzes query structure (filters, sorting, joins) to suggest potential
 * database index optimizations for slow queries.
 */
export function analyzeIndexSuggestions(
  model?: string,
  action?: string,
  args?: Record<string, unknown>,
): string[] {
  const suggestions: string[] = [];

  if (!model || !args) {
    return suggestions;
  }

  const where = args['where'] as Record<string, unknown> | undefined;
  const orderBy = args['orderBy'] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;

  if (where && typeof where === 'object') {
    const filterKeys = Object.keys(where).filter((k) => !['AND', 'OR', 'NOT'].includes(k));
    if (filterKeys.length > 1) {
      suggestions.push(
        `Consider a composite index on model '${model}' for fields: [${filterKeys.join(', ')}]`,
      );
    } else if (filterKeys.length === 1) {
      suggestions.push(`Verify single-column index on model '${model}' field: '${filterKeys[0]}'`);
    }

    if (orderBy) {
      const orderKeys = Array.isArray(orderBy)
        ? orderBy.flatMap((o) => Object.keys(o))
        : Object.keys(orderBy);
      if (orderKeys.length > 0 && filterKeys.length > 0) {
        suggestions.push(
          `Consider compound index on model '${model}' combining filters [${filterKeys.join(', ')}] and sort [${orderKeys.join(', ')}]`,
        );
      }
    }
  }

  if (action === 'findMany' && !args['take'] && !args['cursor']) {
    suggestions.push(
      `Unbounded findMany on model '${model}': add limit/take pagination or keyset cursor to reduce scan volume`,
    );
  }

  return suggestions;
}

/**
 * Creates a Prisma middleware handler that intercepts and times query execution,
 * emitting structured warning logs whenever execution exceeds the configured threshold.
 */
export function createSlowQueryMiddleware(options: SlowQueryLoggerOptions = {}): Prisma.Middleware {
  const thresholdMs = options.thresholdMs ?? 250;
  const enabled = options.enabled ?? true;
  const logger = options.logger ?? new Logger('PrismaSlowQuery');

  return async (params: Prisma.MiddlewareParams, next: (params: Prisma.MiddlewareParams) => Promise<unknown>) => {
    if (!enabled) {
      return next(params);
    }

    const startTime = Date.now();
    try {
      return await next(params);
    } finally {
      const durationMs = Date.now() - startTime;
      if (durationMs >= thresholdMs) {
        const sanitizedArgs = sanitizeQueryArgs(params.args) as Record<string, unknown> | undefined;
        const indexRecommendations = analyzeIndexSuggestions(params.model, params.action, sanitizedArgs);

        const report: SlowQueryReport = {
          model: params.model,
          action: params.action,
          durationMs,
          thresholdMs,
          args: sanitizedArgs,
          indexRecommendations,
          timestamp: new Date().toISOString(),
        };

        logger.warn(
          `[Slow Query] ${params.model ? `${params.model}.${params.action}` : params.action} took ${durationMs}ms (threshold: ${thresholdMs}ms)`,
          JSON.stringify(report),
        );

        if (options.onSlowQuery) {
          try {
            options.onSlowQuery(report);
          } catch (callbackErr) {
            logger.error(`Error in onSlowQuery callback: ${(callbackErr as Error).message}`);
          }
        }
      }
    }
  };
}

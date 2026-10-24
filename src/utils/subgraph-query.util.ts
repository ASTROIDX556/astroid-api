import { retryWithBackoff, isTransientNetworkError } from './retry.util';
import { TtlCache } from './ttl-cache.util';

/** Minimal fetch signature so callers (and tests) can inject alternative transports. */
export type SubgraphFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SubgraphQueryExecutionOptions {
  /** Subgraph endpoint accepting GraphQL over POST. */
  url: string;
  /** GraphQL query to execute. Callers must only send idempotent reads. */
  query: string;
  variables?: Record<string, unknown>;
  /** Total number of attempts (including the first). Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds for the first retry. Defaults to 500. */
  baseDelayMs?: number;
  /** Maximum delay (ms) between attempts. Defaults to 30_000. */
  maxDelayMs?: number;
  /** Fetch implementation override (tests / alternative transports). */
  fetchImpl?: SubgraphFetch;
  /** Extra headers merged with the JSON content type. */
  headers?: Record<string, string>;
  /**
   * When set (> 0), successful responses are cached in-memory for this many
   * milliseconds. Only use for *immutable* reads (e.g. stream/contract
   * metadata) where a fresh copy is guaranteed to be identical.
   */
  cacheTtlMs?: number;
  /** Cache instance override (tests / isolated caches). Defaults to a shared module-level cache. */
  cache?: TtlCache;
  /**
   * Skip the cache read and fetch fresh data (the fresh value still refreshes
   * the cache entry). Use when fresh data is explicitly required.
   */
  bypassCache?: boolean;
}

/**
 * Shared cache used when `cacheTtlMs` is provided without an explicit
 * instance. Bounded so long-running processes keep a predictable footprint.
 */
const defaultSubgraphQueryCache = new TtlCache({ maxEntries: 250 });

/** Cache identity: endpoint + query text + variables. */
function buildCacheKey(options: SubgraphQueryExecutionOptions): string {
  return JSON.stringify([options.url, options.query, options.variables ?? {}]);
}

/**
 * Executes a GraphQL query against a subgraph with automatic retries for
 * transient failures only.
 *
 * - Retries transient errors (5xx responses, network timeouts, connection
 *   resets) using exponential backoff with jitter, up to `maxAttempts`.
 * - Fails immediately (no retry) on client-side errors such as 4xx responses
 *   or GraphQL execution errors (e.g. syntax / validation failures).
 * - Optionally serves immutable reads from a bounded in-memory TTL cache
 *   (`cacheTtlMs`), with `bypassCache` forcing a fresh fetch.
 * - Re-throws the last error once all attempts are exhausted.
 */
export async function executeSubgraphQuery<T = unknown>(
  options: SubgraphQueryExecutionOptions,
): Promise<T> {
  const cache = options.cache ?? defaultSubgraphQueryCache;
  const cacheKey =
    options.cacheTtlMs !== undefined && options.cacheTtlMs > 0
      ? buildCacheKey(options)
      : undefined;

  // Serve immutable reads from cache unless the caller wants fresh data.
  if (cacheKey !== undefined && !options.bypassCache) {
    const cached = cache.get<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const value = await retryWithBackoff(
    async (): Promise<T> => {
      const response = await (options.fetchImpl ?? fetch)(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify({ query: options.query, variables: options.variables ?? {} }),
      });

      if (!response.ok) {
        const error = new Error(`Subgraph query failed with status ${response.status}`) as Error & {
          status: number;
        };
        error.status = response.status;
        throw error;
      }

      const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };

      if (body.errors?.length) {
        const error = new Error(
          `Subgraph query failed: ${body.errors.map((e) => e?.message).filter(Boolean).join('; ')}`,
        ) as Error & { retryable?: boolean };
        // GraphQL-level errors (syntax / validation) are deterministic.
        error.retryable = false;
        throw error;
      }

      return body.data ?? ({} as T);
    },
    {
      maxAttempts: options.maxAttempts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      isRetryable: isTransientNetworkError,
      operationName: 'Subgraph query',
    },
  );

  // Only successful responses are cached; failures propagate above.
  if (cacheKey !== undefined) {
    cache.set(cacheKey, value, options.cacheTtlMs);
  }

  return value;
}

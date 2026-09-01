export interface DatasourceUrlOptions {
  /** Prisma `connection_limit` — max connections in the pool. */
  connectionLimit?: number;
  /**
   * Prisma `pool_timeout` in milliseconds (converted to seconds in the URL,
   * which is the unit Prisma's PostgreSQL connector expects). 0/omitted keeps
   * the default wait behavior.
   */
  poolTimeoutMs?: number;
  /**
   * Server-side Postgres `statement_timeout` in milliseconds, passed via the
   * `options` connection parameter (`options=-c statement_timeout=...`). When
   * the client-side race guard fires, this is what actually aborts the runaway
   * query and releases the pooled connection. 0/omitted disables it.
   */
  statementTimeoutMs?: number;
}

/**
 * Builds the Prisma datasource URL with connection-pool and query-timeout
 * parameters. Existing query parameters (e.g. `?schema=public`) are preserved.
 *
 * Supported Prisma PostgreSQL URL arguments (see Prisma docs — PostgreSQL
 * connector): `connection_limit`, `pool_timeout` (seconds), and `options`
 * (command-line options sent to the server at connection start).
 */
export function buildDatasourceUrl(
  baseUrl: string,
  options: DatasourceUrlOptions = {},
): string {
  const url = new URL(baseUrl);

  if (options.connectionLimit != null && options.connectionLimit > 0) {
    url.searchParams.set('connection_limit', String(options.connectionLimit));
  }

  if (options.poolTimeoutMs != null && options.poolTimeoutMs > 0) {
    // Prisma expresses pool_timeout in seconds; round up to at least 1s.
    const seconds = Math.max(1, Math.round(options.poolTimeoutMs / 1000));
    url.searchParams.set('pool_timeout', String(seconds));
  }

  if (options.statementTimeoutMs != null && options.statementTimeoutMs > 0) {
    // Prisma's documented connection format encodes the space inside the
    // `options` value as %20 (e.g. options=-c%20statement_timeout%3D10000);
    // URLSearchParams would emit '+', so append the param manually.
    const separator = url.search ? '&' : '?';
    url.search = `${url.search}${separator}options=-c%20statement_timeout%3D${options.statementTimeoutMs}`;
  }

  return url.toString();
}

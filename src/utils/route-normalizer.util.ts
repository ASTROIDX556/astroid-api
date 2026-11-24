const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const OTHER_ID_SEGMENT = /^[a-z0-9_-]{16,}$/i;

/**
 * Collapses a request path into a low-cardinality label suitable for
 * Prometheus metrics. Replaces UUIDs, numeric ids, and other opaque
 * identifier-shaped segments with `:id`, and strips the query string.
 */
export function normalizeRoutePath(rawPath: string): string {
  const path = rawPath.split('?')[0] || '/';

  const segments = path.split('/').map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    if (
      UUID_SEGMENT.test(segment) ||
      NUMERIC_SEGMENT.test(segment) ||
      OTHER_ID_SEGMENT.test(segment)
    ) {
      return ':id';
    }
    return segment;
  });

  const normalized = segments.join('/');
  return normalized.length > 0 ? normalized : '/';
}

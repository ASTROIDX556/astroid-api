import { RequestContext } from '../common/context/request-context';
import { QueueJobMetadata } from './queues.constants';

/**
 * Logged as the `requestId` of a job that carries none: it was enqueued outside
 * a request (a scheduler, cron, a seed) or before correlation fields existed.
 * Deliberately not shaped like a real request id, so nobody searches the API
 * logs for it.
 */
export const NO_REQUEST_CONTEXT = 'no-request-context';

/** The keys of {@link QueueJobMetadata}, in the order they are read and logged. */
export const JOB_METADATA_KEYS = [
  'requestId',
  'correlationId',
  'traceId',
  'actorId',
  'apiKeyId',
] as const satisfies ReadonlyArray<keyof QueueJobMetadata>;

/**
 * Snapshot of the correlation fields of the request the caller is running in.
 * Outside a request it is empty, so enqueueing from a scheduler or a seed just
 * produces no metadata. Only ids are read, never credentials.
 */
export function currentJobMetadata(): QueueJobMetadata {
  const candidate: QueueJobMetadata = {
    requestId: RequestContext.getRequestId(),
    correlationId: RequestContext.getCorrelationId(),
    traceId: RequestContext.getTraceId(),
    actorId: RequestContext.getActorId(),
    apiKeyId: RequestContext.getApiKeyId(),
  };
  return pickDefined(candidate);
}

/**
 * Adds the current request's correlation fields to a job payload's `metadata`.
 * Fields the producer already set are kept, so a producer that knows better
 * (for example from a domain event that is handled later) wins over the ambient
 * request. `metadata` is only written when there is something to put in it, so a
 * payload enqueued outside a request is returned unchanged.
 */
export function withJobMetadata<T extends object>(
  data: T,
  explicit: QueueJobMetadata = {},
): T & { metadata?: QueueJobMetadata } {
  const existing = (data as { metadata?: QueueJobMetadata }).metadata;
  const metadata: QueueJobMetadata = {
    ...currentJobMetadata(),
    ...pickDefined(existing ?? {}),
    ...pickDefined(explicit),
  };
  return Object.keys(metadata).length > 0 ? { ...data, metadata } : data;
}

/**
 * Reads the correlation fields of a job payload, from `data.metadata` or from
 * the top level of the payload (older jobs and the dead-letter copies keep them
 * there). Anything that is not a non-empty string is ignored, so a malformed or
 * pre-existing payload never throws.
 */
export function readJobMetadata(data: unknown): QueueJobMetadata {
  if (!data || typeof data !== 'object') return {};
  const payload = data as Record<string, unknown>;
  const nested =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {};

  const result: QueueJobMetadata = {};
  for (const key of JOB_METADATA_KEYS) {
    const value = nested[key] ?? payload[key];
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  return result;
}

function pickDefined(metadata: QueueJobMetadata): QueueJobMetadata {
  const result: QueueJobMetadata = {};
  for (const key of JOB_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  return result;
}

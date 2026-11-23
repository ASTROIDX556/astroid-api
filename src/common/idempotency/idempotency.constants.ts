/**
 * Request-context keys used to replay the original metadata of a cached
 * idempotent response. `ResponseInterceptor` reads them while it builds the
 * success envelope, so a replay returns the original status code and request id
 * instead of the replaying request's values.
 */
export const IDEMPOTENT_REPLAY_REQUEST_ID = 'idempotency.replay.requestId';
export const IDEMPOTENT_REPLAY_STATUS = 'idempotency.replay.statusCode';
/** Set in the request context when a response is replayed from a stored key, so
 * the response interceptor can surface `meta.idempotentReplay: true` to clients. */
export const IDEMPOTENT_REPLAY = 'idempotency.replay';

/** Status code stored for a first (non-replayed) successful execution. */
export const IDEMPOTENT_DEFAULT_STATUS = 201;

/** Route recorded by the transaction execution endpoint. */
export const TRANSACTION_CREATE_ROUTE = 'POST /transactions';

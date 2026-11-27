/** Custom HTTP headers used across the platform. */
export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const API_KEY_HEADER = 'x-api-key';
export const WEBHOOK_SIGNATURE_HEADER = 'x-astroid-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-astroid-timestamp';
export const WEBHOOK_EVENT_ID_HEADER = 'x-astroid-event-id';
export const WEBHOOK_DELIVERY_HEADER = 'x-astroid-delivery';
export const WEBHOOK_EVENT_HEADER = 'x-astroid-event';
export const WEBHOOK_SIGNATURE_VERSION_HEADER = 'x-astroid-signature-version';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set to `true` when a response was replayed from an idempotency record. */
/** Set to `true` on a response served from a stored idempotent result. */
export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replay';
/** Contract name of the replay marker; sent alongside the legacy header above. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';
/** Total number of rows matching a list request, set on every paginated response. */
export const TOTAL_COUNT_HEADER = 'x-total-count';
export const RATE_LIMIT_LIMIT_HEADER = 'X-RateLimit-Limit';
export const RATE_LIMIT_REMAINING_HEADER = 'X-RateLimit-Remaining';
export const RATE_LIMIT_RESET_HEADER = 'X-RateLimit-Reset';
export const RETRY_AFTER_HEADER = 'Retry-After';

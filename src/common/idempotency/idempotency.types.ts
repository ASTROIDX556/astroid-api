/** Everything that identifies one idempotent execution. */
export interface IdempotencyScope {
  /** Authenticated principal (user or API-key owner) the key belongs to. */
  principalId: string;
  /**
   * Credential namespace, e.g. `user:<id>` or `apikey:<id>`. Defaults to
   * `principalId` for callers that have no credential type to distinguish.
   */
  scope?: string;
  /** Normalised route identity, e.g. `POST /api/v1/transactions`. */
  route: string;
  /** Raw `Idempotency-Key` header value. */
  key: string;
  /** Parsed request body used for deterministic request hashing. */
  requestBody: unknown;
}

/** Response persisted after a successful execution and replayed on duplicates. */
export interface StoredIdempotentResponse {
  statusCode: number;
  body: unknown;
  /** Request id of the original execution, preserved on replay. */
  requestId?: string | null;
}

/** Handle returned by {@link IdempotencyService.begin}. */
export interface IdempotencyHandle {
  /** Set when this request must replay an earlier completed response. */
  replay?: StoredIdempotentResponse;
  /** Persist the successful response and release the in-progress lock. */
  complete(response: StoredIdempotentResponse): Promise<void>;
  /** Release the reservation so the caller may retry (e.g. after a 5xx). */
  fail(): Promise<void>;
}

/** The same key was reused with a different request body (HTTP 409). */
export class IdempotencyMismatchError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request body');
    this.name = 'IdempotencyMismatchError';
  }
}

/** A duplicate request arrived while the original is still in flight (HTTP 409). */
export class IdempotencyInFlightError extends Error {
  constructor(
    /** Seconds the client should wait before retrying. */
    readonly retryAfterSeconds: number,
  ) {
    super('A request with this Idempotency-Key is currently being processed; retry shortly');
    this.name = 'IdempotencyInFlightError';
  }
}

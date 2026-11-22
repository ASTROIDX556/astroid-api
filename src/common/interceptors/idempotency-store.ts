/**
 * Persistence contract used by {@link IdempotencyInterceptor}.
 *
 * The interceptor owns the record/replay/conflict protocol; the store only
 * persists it. Keeping the contract in `src/common` lets any module provide a
 * storage adapter without depending on the transaction module.
 */
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export type IdempotencyRecordStatus = 'PROCESSING' | 'COMPLETED';

/** The response captured from the first successful execution. */
export interface StoredIdempotentResponse {
  statusCode: number;
  body: unknown;
}

/** A stored idempotency key, scoped to one actor and one route. */
export interface IdempotencyRecord {
  id: string;
  requestHash: string;
  status: IdempotencyRecordStatus;
  response: StoredIdempotentResponse | null;
  expiresAt: Date;
}

/** Identity of an idempotent request: tenant-scoped actor + route + key. */
export interface IdempotencyIdentity {
  /**
   * Tenant-scoped actor (`<organizationId>:<userId|apiKeyId>`), so keys from
   * different tenants or API keys can never collide.
   */
  principalId: string;
  /** Route the key is scoped to, e.g. `POST /transactions`. */
  route: string;
  /** SHA-256 of the raw `Idempotency-Key` header; the key itself is never stored. */
  keyHash: string;
}

export interface IdempotencyReservationInput extends IdempotencyIdentity {
  /** Stable fingerprint of the request payload. */
  requestHash: string;
  expiresAt: Date;
}

export interface IdempotencyReservation {
  /** True when this caller created the record and may execute the handler. */
  created: boolean;
  record: IdempotencyRecord;
}

export interface IdempotencyStore {
  /**
   * Attempts to create the record. Must rely on a unique constraint rather
   * than a read-then-write check so concurrent requests cannot both win.
   */
  reserve(input: IdempotencyReservationInput): Promise<IdempotencyReservation>;

  /** Returns the live (non-expired) record, or null when it is absent/expired. */
  find(identity: IdempotencyIdentity): Promise<IdempotencyRecord | null>;

  /** Marks the record completed with the response that should be replayed. */
  complete(id: string, response: StoredIdempotentResponse, expiresAt: Date): Promise<void>;

  /** Drops a reservation whose handler failed, so a retry can execute. */
  release(id: string): Promise<void>;

  /** Deletes expired records. Returns the number of rows removed. */
  deleteExpired(now?: Date): Promise<number>;
}

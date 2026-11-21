import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent_request';

/** Default retention window for stored idempotency records: 6 hours. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;

export interface IdempotentOptions {
  /**
   * How long the key + response stay replayable, in milliseconds. Defaults to
   * `IDEMPOTENCY_TTL_MS` (or {@link DEFAULT_IDEMPOTENCY_TTL_MS}, 6 hours).
   */
  ttlMs?: number;
  /**
   * Whether a missing `Idempotency-Key` must be rejected with 400. Defaults to
   * true for the endpoints this decorator guards.
   */
  required?: boolean;
  /**
   * How long a duplicate that arrives while the first request is still in
   * flight waits for it to complete before answering 409, in milliseconds.
   * Defaults to 2000.
   */
  waitForCompletionMs?: number;
}

/**
 * Marks a controller method as requiring idempotency enforcement.
 *
 * The endpoint then requires an `Idempotency-Key` header, replays the stored
 * response for repeats with the same payload, answers 409 for repeats with a
 * different payload, and lets concurrent duplicates execute only once.
 * Endpoints without this decorator keep their previous behaviour.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, options);

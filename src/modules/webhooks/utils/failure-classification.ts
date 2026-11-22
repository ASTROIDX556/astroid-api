import {
  WebhookDestinationError,
  WebhookDestinationResolutionError,
} from '../webhook-destination.policy';

/**
 * The only HTTP statuses a webhook delivery is retried on: request timeout
 * (408), rate limiting (429) and every 5xx. All other 4xx responses and every
 * redirect are permanent rejections — retrying them cannot change the outcome.
 *
 * This predicate is the single source of truth for the retry decision: the
 * worker aborts a delivery when it returns false and the failure classifier
 * reports the same answer, so the delivery log, the circuit and the emitted
 * events always describe what actually happened.
 */
export function isRetryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** @deprecated Use {@link isRetryableWebhookStatus}; kept for compatibility. */
export const NON_TRANSIENT_WEBHOOK_STATUSES = new Set([400, 401, 403, 404, 422]);

/**
 * Broad class of a failed webhook delivery attempt.
 *
 * The category decides whether the delivery is worth retrying and what is
 * written into the structured failure metadata of the delivery log.
 */
export enum WebhookFailureCategory {
  /** The endpoint is temporarily unavailable (5xx, rate limit, network error). */
  Transient = 'transient',
  /** The endpoint rejected the delivery in a way that will not change on a retry. */
  Permanent = 'permanent',
  /** The endpoint did not answer within the configured timeout. */
  Timeout = 'timeout',
  /** The delivery was skipped because the endpoint's circuit was open. */
  CircuitOpen = 'circuit-open',
}

/** Machine-readable classification of one failed delivery attempt. */
export interface WebhookFailureClassification {
  /** Broad class of the failure. */
  category: WebhookFailureCategory;
  /** Stable, machine-readable reason (e.g. `HTTP_503`, `TIMEOUT`). */
  code: string;
  /** True when the failure is worth retrying. */
  transient: boolean;
}

/**
 * Classifies a failed delivery attempt.
 *
 * The rules mirror the worker's own retry decision: only 408, 429 and 5xx are
 * retried, while a redirect, any other 4xx, or a rejected destination abandons
 * the delivery. A DNS failure, a timeout or a network error is retried.
 *
 * @param error          the error thrown by the delivery attempt
 * @param responseStatus the HTTP status the endpoint answered with, when any
 */
export function classifyWebhookFailure(
  error: unknown,
  responseStatus?: number,
): WebhookFailureClassification {
  if (error instanceof WebhookDestinationError) {
    return {
      category: WebhookFailureCategory.Permanent,
      code: 'DESTINATION_REJECTED',
      transient: false,
    };
  }

  if (error instanceof WebhookDestinationResolutionError) {
    return {
      category: WebhookFailureCategory.Transient,
      code: 'DNS_FAILURE',
      transient: true,
    };
  }

  if (responseStatus !== undefined) {
    return classifyHttpStatus(responseStatus);
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) {
    return {
      category: WebhookFailureCategory.Timeout,
      code: 'TIMEOUT',
      transient: true,
    };
  }

  const httpStatus = /^HTTP (\d{3})$/.exec(message);
  if (httpStatus) {
    return classifyHttpStatus(Number(httpStatus[1]));
  }

  return {
    category: WebhookFailureCategory.Transient,
    code: 'DELIVERY_FAILED',
    transient: true,
  };
}

/** Classifies an HTTP status the endpoint answered with. */
export function classifyHttpStatus(status: number): WebhookFailureClassification {
  // A redirect is never followed: the delivery is abandoned immediately.
  if (status >= 300 && status < 400) {
    return {
      category: WebhookFailureCategory.Permanent,
      code: `HTTP_${status}`,
      transient: false,
    };
  }

  if (isRetryableWebhookStatus(status)) {
    return {
      category: WebhookFailureCategory.Transient,
      code: `HTTP_${status}`,
      transient: true,
    };
  }

  return {
    category: WebhookFailureCategory.Permanent,
    code: `HTTP_${status}`,
    transient: false,
  };
}

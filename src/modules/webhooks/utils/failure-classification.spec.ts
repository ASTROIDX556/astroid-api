import { describe, expect, it } from 'vitest';

import {
  WebhookFailureCategory,
  classifyHttpStatus,
  classifyWebhookFailure,
} from './failure-classification';
import {
  WebhookDestinationError,
  WebhookDestinationResolutionError,
} from '../webhook-destination.policy';

describe('classifyHttpStatus', () => {
  it('treats a 5xx status as transient', () => {
    const result = classifyHttpStatus(503);

    expect(result).toEqual({
      category: WebhookFailureCategory.Transient,
      code: 'HTTP_503',
      transient: true,
    });
  });

  it('treats a 4xx status as permanent', () => {
    const result = classifyHttpStatus(404);

    expect(result).toEqual({
      category: WebhookFailureCategory.Permanent,
      code: 'HTTP_404',
      transient: false,
    });
  });

  it('keeps 408, 425 and 429 retryable', () => {
    for (const status of [408, 425, 429]) {
      const result = classifyHttpStatus(status);
      expect(result.transient).toBe(true);
      expect(result.category).toBe(WebhookFailureCategory.Transient);
    }
  });

  it('treats a redirect as permanent', () => {
    // The delivery is abandoned immediately: a redirect is never followed.
    const result = classifyHttpStatus(302);

    expect(result).toEqual({
      category: WebhookFailureCategory.Permanent,
      code: 'HTTP_302',
      transient: false,
    });
  });

  it('treats the non-transient statuses as permanent', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const result = classifyHttpStatus(status);
      expect(result.transient).toBe(false);
      expect(result.category).toBe(WebhookFailureCategory.Permanent);
    }
  });

  it('keeps the remaining 4xx statuses retryable, like the worker does', () => {
    for (const status of [405, 409, 410, 415, 429]) {
      expect(classifyHttpStatus(status).transient).toBe(true);
    }
  });
});

describe('classifyWebhookFailure', () => {
  it('marks a rejected destination as permanent', () => {
    const result = classifyWebhookFailure(
      new WebhookDestinationError('Webhook URL must use HTTPS'),
    );

    expect(result).toEqual({
      category: WebhookFailureCategory.Permanent,
      code: 'DESTINATION_REJECTED',
      transient: false,
    });
  });

  it('marks a DNS failure as transient', () => {
    const result = classifyWebhookFailure(new WebhookDestinationResolutionError());

    expect(result).toEqual({
      category: WebhookFailureCategory.Transient,
      code: 'DNS_FAILURE',
      transient: true,
    });
  });

  it('recognises a timeout', () => {
    const result = classifyWebhookFailure(new Error('Webhook request timed out'));

    expect(result).toEqual({
      category: WebhookFailureCategory.Timeout,
      code: 'TIMEOUT',
      transient: true,
    });
  });

  it('recognises a timeout reported by the socket', () => {
    expect(classifyWebhookFailure(new Error('connect ETIMEDOUT')).code).toBe('TIMEOUT');
  });

  it('reads the status out of an HTTP error message', () => {
    const result = classifyWebhookFailure(new Error('HTTP 500'));

    expect(result).toEqual({
      category: WebhookFailureCategory.Transient,
      code: 'HTTP_500',
      transient: true,
    });
  });

  it('prefers the response status over the error message', () => {
    const result = classifyWebhookFailure(new Error('HTTP 500'), 404);

    expect(result.code).toBe('HTTP_404');
    expect(result.transient).toBe(false);
  });

  it('falls back to a generic transient failure', () => {
    const result = classifyWebhookFailure(new Error('socket hang up'));

    expect(result).toEqual({
      category: WebhookFailureCategory.Transient,
      code: 'DELIVERY_FAILED',
      transient: true,
    });
  });

  it('never treats an unknown failure as permanent', () => {
    expect(classifyWebhookFailure(undefined).transient).toBe(true);
  });
});

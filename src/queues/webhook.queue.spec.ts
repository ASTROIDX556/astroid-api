import { describe, expect, it, vi } from 'vitest';
import { Backoffs } from 'bullmq';

import { Queues } from './queues.constants';
import {
  WEBHOOK_DEAD_LETTER_QUEUE,
  WEBHOOK_JOB_NAME,
  createWebhookQueueOptions,
  webhookJobOptionsFor,
  webhookRetryDelayMs,
} from './webhook.queue';
import { DEFAULT_WEBHOOK_CONFIG, WebhookConfig } from '../config/webhook.config';

const SETTINGS: WebhookConfig = { ...DEFAULT_WEBHOOK_CONFIG };

describe('webhook queue configuration', () => {
  it('retries a delivery five times with an exponential backoff', () => {
    const options = webhookJobOptionsFor(SETTINGS);

    expect(options.attempts).toBe(5);
    expect(options.backoff).toEqual({ type: 'custom', delay: 2_000 });
  });

  it('keeps completed jobs bounded and failed jobs inspectable for a day', () => {
    const options = webhookJobOptionsFor(SETTINGS);

    expect(options.removeOnComplete).toEqual({ count: 1_000 });
    expect(options.removeOnFail).toEqual({ age: 24 * 3_600, count: 5_000 });
  });

  it('registers the queue under the webhook name with the shared job options', () => {
    const options = createWebhookQueueOptions(SETTINGS);

    expect(options.name).toBe(Queues.Webhooks);
    expect(options.defaultJobOptions).toEqual(webhookJobOptionsFor(SETTINGS));
  });

  it('uses the custom backoff type so the registered strategy is actually used', () => {
    // BullMQ prefers its built-in `fixed` and `exponential` strategies over a
    // registered custom strategy, so only the `custom` type applies the
    // jitter and the maximum delay.
    const backoff = webhookJobOptionsFor(SETTINGS).backoff as { type: string };
    expect(backoff.type).toBe('custom');
  });

  it('attaches a jittered backoff strategy so retries never fire in lockstep', () => {
    const settings = createWebhookQueueOptions(SETTINGS).settings as unknown as {
      backoffStrategy: (attemptsMade: number) => number;
    };

    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // The first retry waits the base delay.
      expect(settings.backoffStrategy(1)).toBe(2_000);
      // The second retry doubles the base delay.
      expect(settings.backoffStrategy(2)).toBe(4_000);
    } finally {
      random.mockRestore();
    }
  });

  it('adds jitter to the retry delay', () => {
    const settings = createWebhookQueueOptions(SETTINGS).settings as unknown as {
      backoffStrategy: (attemptsMade: number) => number;
    };

    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      // 2000ms + the maximum jitter of the first attempt (400ms).
      expect(settings.backoffStrategy(1)).toBe(2_400);
    } finally {
      random.mockRestore();
    }
  });

  it('caps the backoff delay at the configured maximum', () => {
    const settings = createWebhookQueueOptions(SETTINGS).settings as unknown as {
      backoffStrategy: (attemptsMade: number) => number;
    };

    // A long outage must never schedule a retry further away than the cap.
    expect(settings.backoffStrategy(50)).toBe(60_000);
    expect(settings.backoffStrategy(50)).toBeLessThanOrEqual(60_000);
  });

  it('schedules the very delay BullMQ computes for the next attempt', async () => {
    const settings = createWebhookQueueOptions(SETTINGS).settings as unknown as {
      backoffStrategy: (attemptsMade: number) => number;
    };
    const backoff = webhookJobOptionsFor(SETTINGS).backoff as {
      type: string;
      delay: number;
    };

    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      for (const attemptsMade of [0, 1, 2, 3]) {
        // BullMQ hands the strategy `attemptsMade + 1`.
        const bullMqDelay = await Backoffs.calculate(
          backoff as never,
          attemptsMade + 1,
          new Error('boom'),
          undefined as never,
          settings.backoffStrategy,
        );
        expect(webhookRetryDelayMs(attemptsMade, SETTINGS)).toBe(bullMqDelay);
      }
    } finally {
      random.mockRestore();
    }
  });

  it('reports the delay the queue schedules for the next attempt', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(webhookRetryDelayMs(0, SETTINGS)).toBe(2_000);
      expect(webhookRetryDelayMs(1, SETTINGS)).toBe(4_000);
      expect(webhookRetryDelayMs(2, SETTINGS)).toBe(8_000);
    } finally {
      random.mockRestore();
    }
  });

  it('routes permanently failed deliveries to the dead-letter queue', () => {
    expect(WEBHOOK_DEAD_LETTER_QUEUE).toBe(Queues.DeadLetter);
  });

  it('uses a single well-known job name for every delivery', () => {
    expect(WEBHOOK_JOB_NAME).toBe('webhook-delivery');
  });
});

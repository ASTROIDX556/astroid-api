import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Job, UnrecoverableError } from 'bullmq';

import { WebhooksProcessor } from './webhooks.processor';
import { WebhookAuditService } from './services/webhook-audit.service';
import { WebhookJobData } from './types/webhook-job.types';

const createDestinationPolicy = () => ({
  post: async (
    url: string,
    options: { headers: Record<string, string>; body: Buffer; timeoutMs: number },
  ) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { status: response.status };
  },
});

/**
 * Terminal-failure behaviour of the webhook processor: retries are scheduled
 * while attempts remain, and a delivery that exhausts them (or hits a
 * non-retryable 4xx) is written to the audit trail exactly once.
 */
describe('WebhooksProcessor terminal failures', () => {
  const jobData: WebhookJobData = {
    webhookId: 'wh-1',
    organizationId: 'org-1',
    url: 'https://downstream.example.com/hook',
    eventName: 'transaction.completed',
    payload: { id: 'txn-1' },
    eventId: 'event-1',
  };

  let recordTerminalFailure: ReturnType<typeof vi.fn>;
  let processor: WebhooksProcessor;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function makeJob(attemptsMade: number): Job<WebhookJobData> {
    return { id: 'job-1', name: 'webhook-delivery', data: jobData, attemptsMade } as unknown as Job<WebhookJobData>;
  }

  beforeEach(() => {
    recordTerminalFailure = vi.fn().mockResolvedValue(undefined);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const destinationPolicy = {
      post: async (url: string, options: { headers: Record<string, string>; body: Buffer; timeoutMs: number }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: options.headers,
          body: options.body.toString('utf8'),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        return { status: response.status };
      },
    };
    processor = new WebhooksProcessor(
      {
        webhook: {
          findFirst: vi.fn().mockResolvedValue({
            secret: 'whsec_test',
            url: jobData.url,
            enabled: true,
          }),
        },
      } as never,
      undefined,
      { recordTerminalFailure } as unknown as WebhookAuditService,
      destinationPolicy,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('schedules a retry without auditing while attempts remain', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('Service Unavailable'),
    });

    await expect(processor.process(makeJob(1))).rejects.toThrow('HTTP 503');

    expect(recordTerminalFailure).not.toHaveBeenCalled();
  });

  it('audits the delivery once the retries are exhausted', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('Service Unavailable'),
    });

    await expect(processor.process(makeJob(4))).rejects.toThrow('HTTP 503');

    expect(recordTerminalFailure).toHaveBeenCalledTimes(1);
    expect(recordTerminalFailure).toHaveBeenCalledWith({
      webhookId: 'wh-1',
      organizationId: 'org-1',
      url: 'https://downstream.example.com/hook',
      eventName: 'transaction.completed',
      eventId: 'event-1',
      attemptsMade: 5,
      failedReason: 'HTTP 503',
      responseStatus: 503,
    });
  });

  it('audits and stops retrying immediately on a non-transient 4xx', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('Not Found'),
    });
    await expect(processor.process(makeJob(0))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(recordTerminalFailure).toHaveBeenCalledTimes(1);
    expect(recordTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attemptsMade: 1, responseStatus: 404 }),
    );
  });

  it('uses the current subscription URL instead of a stale URL in queued job data', async () => {
    const currentUrl = 'https://current.example.com/hook';
    processor = new WebhooksProcessor(
      {
        webhook: {
          findFirst: vi.fn().mockResolvedValue({
            secret: 'whsec_test',
            url: currentUrl,
            enabled: true,
          }),
        },
      } as never,
      undefined,
      undefined,
      createDestinationPolicy(),
    );
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    await processor.process({
      ...makeJob(0),
      data: { ...jobData, url: 'https://stale.example.com/hook' },
    } as Job<WebhookJobData>);

    expect(fetchSpy).toHaveBeenCalledWith(currentUrl, expect.any(Object));
  });

  it('never lets an audit failure mask the original delivery error', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() };
    Object.assign(processor, { logger });
    recordTerminalFailure.mockRejectedValue(new Error('audit unavailable'));
    fetchSpy.mockRejectedValue(new Error('socket hang up'));

    await expect(processor.process(makeJob(4))).rejects.toThrow('Webhook delivery failed');

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not audit webhook'));
  });
});

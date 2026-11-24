import { describe, expect, it, vi } from 'vitest';
import { WebhookAttemptService } from './webhook-attempt.service';

const attempt = {
  webhookId: 'wh-1',
  organizationId: 'org-1',
  eventId: 'evt-1',
  attemptNumber: 2,
  status: 'FAILED' as const,
  responseStatus: 503,
  durationMs: 123.7,
  errorCode: 'HTTP_503',
  errorMessage: 'HTTP 503',
};

describe('WebhookAttemptService', () => {
  it('persists endpoint, status, duration and error details', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'attempt-1' });
    const service = new WebhookAttemptService({ webhookDeliveryAttempt: { create } } as never);

    await service.record(attempt);

    expect(create).toHaveBeenCalledWith({
      data: {
        webhookId: 'wh-1',
        organizationId: 'org-1',
        eventId: 'evt-1',
        attemptNumber: 2,
        status: 'FAILED',
        responseStatus: 503,
        durationMs: 124,
        errorCode: 'HTTP_503',
        errorMessage: 'HTTP 503',
      },
    });
  });

  it('truncates oversized error messages', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'attempt-1' });
    const service = new WebhookAttemptService({ webhookDeliveryAttempt: { create } } as never);

    await service.record({ ...attempt, errorMessage: 'x'.repeat(5_000) });

    const data = create.mock.calls[0][0].data as { errorMessage: string };
    expect(data.errorMessage).toHaveLength(1_000);
  });

  it('never fails a delivery when persistence fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const service = new WebhookAttemptService({ webhookDeliveryAttempt: { create } } as never);

    await expect(service.record(attempt)).resolves.toBeUndefined();
  });
});

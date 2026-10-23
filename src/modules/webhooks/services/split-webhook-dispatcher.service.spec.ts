import { describe, expect, it, vi } from 'vitest';
import { SplitWebhookDispatcherService } from './split-webhook-dispatcher.service';

describe('SplitWebhookDispatcherService (#312)', () => {
  it('dispatches HMAC-SHA256 signed payloads to active matching split subscriptions', async () => {
    const service = new SplitWebhookDispatcherService();
    const transport = vi.fn().mockResolvedValue({ statusCode: 202 });

    const results = await service.dispatchSplitEvent(
      {
        eventId: 'evt-split-1',
        eventType: 'split.transfer.completed',
        organizationId: 'org-1',
        occurredAt: '2026-10-22T09:00:00.000Z',
        data: { amount: '250.0000000', asset: 'USDC' },
      },
      [
        {
          id: 'sub-active',
          url: 'https://hooks.example.com/splits',
          secret: 'whsec_test123',
          active: true,
          events: ['split.transfer.completed'],
        },
        {
          id: 'sub-inactive',
          url: 'https://hooks.example.com/disabled',
          secret: 'whsec_disabled',
          active: false,
          events: ['split.transfer.completed'],
        },
      ],
      transport,
    );

    expect(results).toHaveLength(1);
    expect(results[0].delivered).toBe(true);
    expect(results[0].signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

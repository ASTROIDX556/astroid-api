import { describe, expect, it, vi } from 'vitest';
import { DomainEventName } from '../../../events/event-names';
import { BudgetAlertWorker } from './budget-alert.worker';

const periodStart = new Date('2026-11-01T00:00:00.000Z');

function envelope(payload: Record<string, unknown> = {}) {
  return {
    name: DomainEventName.BudgetThresholdReached,
    organizationId: 'org-1',
    aggregateType: 'budget',
    aggregateId: 'budget-1',
    occurredAt: new Date(),
    payload: {
      budgetId: 'budget-1',
      period: 'MONTHLY',
      periodStart: periodStart.toISOString(),
      threshold: 80,
      usage: '85.0000000',
      limit: '100.0000000',
      utilisation: '85.00',
      currency: 'USDC',
      ...payload,
    },
  } as never;
}

function setup(notified = true) {
  const alerts = {
    findByPeriod: vi.fn().mockResolvedValue({
      id: 'alert-1',
      organizationId: 'org-1',
      budgetId: 'budget-1',
      periodStart,
      threshold: 80,
    }),
    markNotified: vi.fn().mockResolvedValue(notified),
  };
  const notifications = { broadcast: vi.fn().mockResolvedValue({ created: 2 }) };
  return { worker: new BudgetAlertWorker(alerts as never, notifications as never), alerts, notifications };
}

describe('BudgetAlertWorker', () => {
  it('creates notification records for a new alert', async () => {
    const { worker, notifications, alerts } = setup();

    await expect(worker.handle(envelope())).resolves.toBe(true);

    expect(alerts.markNotified).toHaveBeenCalledWith('alert-1');
    expect(notifications.broadcast).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        title: 'Budget threshold reached (80%)',
        metadata: expect.objectContaining({ budgetId: 'budget-1', threshold: 80 }),
      }),
    );
  });

  it('is idempotent: an already-notified alert creates nothing', async () => {
    const { worker, notifications } = setup(false);

    await expect(worker.handle(envelope())).resolves.toBe(false);
    expect(notifications.broadcast).not.toHaveBeenCalled();
  });

  it('ignores an event with no matching ledger row', async () => {
    const { worker, alerts, notifications } = setup();
    alerts.findByPeriod.mockResolvedValue(null);

    await expect(worker.handle(envelope())).resolves.toBe(false);
    expect(notifications.broadcast).not.toHaveBeenCalled();
  });

  it('ignores unrelated envelopes', async () => {
    const { worker, notifications } = setup();

    const unrelated = { ...(envelope() as unknown as Record<string, unknown>), name: 'budget.consumed' };
    await expect(worker.handle(unrelated as never)).resolves.toBe(false);
    expect(notifications.broadcast).not.toHaveBeenCalled();
  });

  it('never throws from the event handler when notifications fail', async () => {
    const { worker, notifications } = setup();
    notifications.broadcast.mockRejectedValue(new Error('smtp down'));

    await expect(worker.onThresholdReached(envelope())).resolves.toBeUndefined();
  });
});

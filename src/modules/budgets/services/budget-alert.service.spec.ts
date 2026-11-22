import { describe, expect, it, vi } from 'vitest';
import { BudgetPeriod, Prisma } from '@prisma/client';
import { BudgetAlertService, currentBudgetPeriodStart } from './budget-alert.service';
import { DomainEventName } from '../../../events/event-names';

const Decimal = Prisma.Decimal;

function budget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'budget-1',
    organizationId: 'org-1',
    currency: 'USDC',
    limitAmount: new Decimal(100),
    spent: new Decimal(0),
    period: BudgetPeriod.MONTHLY,
    periodStart: new Date('2026-11-01T00:00:00.000Z'),
    alertThresholds: [] as number[],
    ...overrides,
  } as never;
}

function config(thresholds = [80, 100]) {
  return { get: vi.fn().mockReturnValue({ thresholds }) } as never;
}

function setup(inserted: (threshold: number) => boolean = () => true) {
  const alerts = {
    createIfAbsent: vi.fn(async (data: { threshold: number }) => inserted(data.threshold)),
    findByPeriod: vi.fn(),
    markNotified: vi.fn(),
    findPending: vi.fn(),
  };
  const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
  const service = new BudgetAlertService(alerts as never, eventBus as never, config());
  return { service, alerts, eventBus };
}

describe('currentBudgetPeriodStart', () => {
  it('advances a monthly anchor into the current period', () => {
    const start = currentBudgetPeriodStart(
      BudgetPeriod.MONTHLY,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-11-22T00:00:00.000Z'),
    );
    expect(start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('advances daily and yearly anchors', () => {
    expect(
      currentBudgetPeriodStart(
        BudgetPeriod.DAILY,
        new Date('2026-11-20T00:00:00.000Z'),
        new Date('2026-11-22T12:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-11-22T00:00:00.000Z');

    expect(
      currentBudgetPeriodStart(
        BudgetPeriod.YEARLY,
        new Date('2024-03-01T00:00:00.000Z'),
        new Date('2026-11-22T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-03-01T00:00:00.000Z');
  });

  it('never rolls a ONE_TIME budget', () => {
    const anchor = new Date('2024-01-01T00:00:00.000Z');
    expect(currentBudgetPeriodStart(BudgetPeriod.ONE_TIME, anchor, new Date()).toISOString()).toBe(
      anchor.toISOString(),
    );
  });
});

describe('BudgetAlertService.evaluate', () => {
  it('emits a typed event when usage crosses a threshold', async () => {
    const { service, eventBus } = setup();

    const emitted = await service.evaluate(
      'org-1',
      budget(),
      new Decimal(85),
      new Date('2026-11-22T00:00:00.000Z'),
    );

    expect(emitted).toEqual([80]);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.BudgetThresholdReached,
      expect.objectContaining({
        budgetId: 'budget-1',
        period: BudgetPeriod.MONTHLY,
        periodStart: '2026-11-01T00:00:00.000Z',
        threshold: 80,
        usage: '85.0000000',
        limit: '100.0000000',
        currency: 'USDC',
      }),
      expect.objectContaining({ organizationId: 'org-1', aggregateType: 'budget' }),
    );
  });

  it('does not emit the same threshold twice in one period', async () => {
    const { service, alerts, eventBus } = setup();

    await service.evaluate('org-1', budget(), new Decimal(82));
    // The ledger rejects the second insert, as the unique constraint would.
    alerts.createIfAbsent.mockResolvedValue(false);
    const emitted = await service.evaluate('org-1', budget(), new Decimal(86));

    expect(emitted).toEqual([]);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(alerts.createIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('emits every threshold crossed in a single spend', async () => {
    const { service, eventBus } = setup();

    const emitted = await service.evaluate('org-1', budget(), new Decimal(120));

    expect(emitted).toEqual([80, 100]);
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
  });

  it('supports per-budget threshold overrides', async () => {
    const { service, eventBus } = setup();

    const emitted = await service.evaluate(
      'org-1',
      budget({ alertThresholds: [50, 90] }),
      new Decimal(95),
    );

    expect(emitted).toEqual([50, 90]);
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh alert ledger in a new budget period', async () => {
    const { service, alerts } = setup();
    const spent = new Decimal(85);

    await service.evaluate('org-1', budget(), spent, new Date('2026-11-22T00:00:00.000Z'));
    await service.evaluate('org-1', budget(), spent, new Date('2026-12-02T00:00:00.000Z'));

    const periodStarts = alerts.createIfAbsent.mock.calls.map((call) =>
      (call[0] as unknown as { periodStart: Date }).periodStart.toISOString(),
    );
    expect(periodStarts).toContain('2026-11-01T00:00:00.000Z');
    expect(periodStarts).toContain('2026-12-01T00:00:00.000Z');
  });

  it('never fails the committed spend when alerting fails', async () => {
    const { service, eventBus } = setup();
    eventBus.emit.mockRejectedValue(new Error('event bus down'));

    await expect(service.evaluate('org-1', budget(), new Decimal(120))).resolves.toEqual([]);
  });

  it('skips budgets with a non-positive limit', async () => {
    const { service, alerts } = setup();

    await expect(
      service.evaluate('org-1', budget({ limitAmount: new Decimal(0) }), new Decimal(10)),
    ).resolves.toEqual([]);
    expect(alerts.createIfAbsent).not.toHaveBeenCalled();
  });
});

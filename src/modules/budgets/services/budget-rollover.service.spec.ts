import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Budget,
  BudgetCarryOverRule,
  BudgetPeriod,
  Prisma,
} from '@prisma/client';
import { BudgetRolloverService } from './budget-rollover.service';
import { BudgetPeriodRepository } from '../budget-period.repository';
import { DEFAULT_BUDGET_ROLLOVER_CONFIG } from '../../../config/budget-rollover.config';
import { DomainEventName } from '../../../events/event-names';

const Decimal = Prisma.Decimal;
const NOW = new Date('2026-02-15T00:00:00.000Z');
const JAN = new Date('2026-01-01T00:00:00.000Z');
const FEB = new Date('2026-02-01T00:00:00.000Z');
const MAR = new Date('2026-03-01T00:00:00.000Z');

const budget = (overrides: Partial<Budget> = {}): Budget =>
  ({
    id: 'budget-1',
    organizationId: 'org-1',
    parentBudgetId: null,
    agentId: null,
    name: 'Ops',
    currency: 'USDC',
    limitAmount: new Decimal(100),
    spent: new Decimal(40),
    period: BudgetPeriod.MONTHLY,
    periodStart: JAN,
    periodEnd: FEB,
    periodAnchor: JAN,
    periodIndex: 0,
    timezone: 'UTC',
    carryOverRule: BudgetCarryOverRule.NONE,
    alertThresholds: [],
    rollover: false,
    enabled: true,
    createdAt: JAN,
    updatedAt: JAN,
    deletedAt: null,
    ...overrides,
  }) as Budget;

describe('BudgetRolloverService', () => {
  let periods: {
    findExpired: ReturnType<typeof vi.fn>;
    lockBudget: ReturnType<typeof vi.fn>;
    closePeriod: ReturnType<typeof vi.fn>;
    openPeriod: ReturnType<typeof vi.fn>;
    syncCurrentPeriod: ReturnType<typeof vi.fn>;
    updateCurrentPeriod: ReturnType<typeof vi.fn>;
  };
  let transactions: { run: ReturnType<typeof vi.fn> };
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let service: BudgetRolloverService;
  let order: string[];

  const build = () =>
    new BudgetRolloverService(
      periods as unknown as BudgetPeriodRepository,
      transactions as never,
      eventBus as never,
      config as never,
    );

  beforeEach(() => {
    order = [];
    periods = {
      findExpired: vi.fn().mockResolvedValue([]),
      lockBudget: vi.fn().mockResolvedValue(budget()),
      closePeriod: vi.fn(async (_tx, _input) => {
        order.push('close');
        return undefined;
      }),
      openPeriod: vi.fn(async (_tx, input) => {
        order.push('open');
        return { record: { openingBalance: input.openingBalance }, created: true };
      }),
      syncCurrentPeriod: vi.fn(async () => {
        order.push('budget-sync');
      }),
      updateCurrentPeriod: vi.fn(async () => {
        order.push('budget-update');
      }),
    };
    transactions = {
      run: vi.fn(async (fn) => {
        const result = await fn({});
        order.push('commit');
        return result;
      }),
    };
    eventBus = {
      emit: vi.fn(async () => {
        order.push('event');
      }),
    };
    config = {
      get: vi.fn(() => ({ ...DEFAULT_BUDGET_ROLLOVER_CONFIG, batchSize: 10, maxBatches: 10 })),
    };
    service = build();
  });

  it('closes the expired period, opens the next and emits after the commit', async () => {
    const result = await service.rolloverBudget('budget-1', NOW);

    expect(result.outcome).toBe('rolled_over');
    expect(periods.closePeriod).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        budgetId: 'budget-1',
        periodStart: JAN,
        periodEnd: FEB,
        finalSpent: new Decimal(40),
      }),
    );
    expect(periods.openPeriod).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ periodStart: FEB, periodEnd: MAR, openingBalance: new Decimal(0) }),
    );
    expect(periods.updateCurrentPeriod).toHaveBeenCalledWith(
      {},
      'budget-1',
      expect.objectContaining({ periodStart: FEB, periodEnd: MAR, spent: new Decimal(0), periodIndex: 1 }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.BudgetPeriodRollover,
      expect.objectContaining({
        budgetId: 'budget-1',
        closedPeriodStart: JAN.toISOString(),
        periodStart: FEB.toISOString(),
        spent: '40.0000000',
        carryOverAmount: '0.0000000',
        periodsClosed: 1,
      }),
      expect.objectContaining({ organizationId: 'org-1', aggregateType: 'budget' }),
    );
    expect(order).toEqual(['close', 'open', 'budget-update', 'budget-sync', 'commit', 'event']);
  });

  it('does not reopen an already-current period', async () => {
    periods.lockBudget.mockResolvedValue(budget({ periodStart: FEB, periodEnd: MAR, periodIndex: 1 }));

    const result = await service.rolloverBudget('budget-1', NOW);

    expect(result.outcome).toBe('skipped');
    expect(periods.closePeriod).not.toHaveBeenCalled();
    expect(periods.openPeriod).not.toHaveBeenCalled();
    expect(periods.syncCurrentPeriod).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('skips paused and archived budgets', async () => {
    periods.lockBudget.mockResolvedValueOnce(budget({ enabled: false }));
    periods.lockBudget.mockResolvedValueOnce(budget({ deletedAt: new Date() }));

    await expect(service.rolloverBudget('budget-1', NOW)).resolves.toMatchObject({
      outcome: 'skipped',
    });
    await expect(service.rolloverBudget('budget-1', NOW)).resolves.toMatchObject({
      outcome: 'skipped',
    });

    expect(periods.closePeriod).not.toHaveBeenCalled();
    expect(periods.openPeriod).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it.each([
    { rule: BudgetCarryOverRule.NONE, opening: '0.0000000' },
    { rule: BudgetCarryOverRule.UNUSED, opening: '60.0000000' },
    { rule: BudgetCarryOverRule.OVERSPEND, opening: '0.0000000' },
    { rule: BudgetCarryOverRule.NET, opening: '60.0000000' },
  ])('applies the $rule carry-over rule', async ({ rule, opening }) => {
    periods.lockBudget.mockResolvedValue(budget({ carryOverRule: rule }));
    periods.openPeriod.mockImplementation(async (_tx, input) => ({
      record: { openingBalance: input.openingBalance },
      created: true,
    }));

    await service.rolloverBudget('budget-1', NOW);

    expect(periods.openPeriod).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ openingBalance: new Decimal(opening) }),
    );
    expect(periods.updateCurrentPeriod).toHaveBeenCalledWith(
      {},
      'budget-1',
      expect.objectContaining({ spent: new Decimal(opening) }),
    );
  });

  it('carries overspend as a negative opening balance', async () => {
    periods.lockBudget.mockResolvedValue(
      budget({ spent: new Decimal(120), carryOverRule: BudgetCarryOverRule.OVERSPEND }),
    );

    await service.rolloverBudget('budget-1', NOW);

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.BudgetPeriodRollover,
      expect.objectContaining({ carryOverAmount: '-20.0000000' }),
      expect.anything(),
    );
  });

  it('closes every elapsed window after a long outage', async () => {
    const result = await service.rolloverBudget('budget-1', new Date('2026-03-15T00:00:00.000Z'));

    expect(result.periodsClosed).toBe(2);
    expect(periods.closePeriod).toHaveBeenCalledTimes(2);
    expect(periods.updateCurrentPeriod).toHaveBeenLastCalledWith(
      {},
      'budget-1',
      expect.objectContaining({ periodIndex: 2, periodStart: MAR }),
    );
    expect(eventBus.emit).toHaveBeenCalledOnce();
  });

  it('pages expired budgets with a stable cursor and a bounded number of batches', async () => {
    config.get.mockReturnValue({ ...DEFAULT_BUDGET_ROLLOVER_CONFIG, batchSize: 2, maxBatches: 5 });
    const first = [budget({ id: 'a' }), budget({ id: 'b' })];
    const second = [budget({ id: 'c' })];
    periods.findExpired.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    periods.lockBudget.mockImplementation(async (_tx, id: string) => budget({ id }));

    const summary = await service.rolloverExpired(NOW);

    expect(summary).toMatchObject({ scanned: 3, batches: 2, rolledOver: 3, failed: 0 });
    expect(periods.findExpired.mock.calls[0][2]).toBeUndefined();
    expect(periods.findExpired.mock.calls[1][2]).toBe('b');
    expect(eventBus.emit).toHaveBeenCalledTimes(3);
  });

  it('isolates one budget failure and continues the batch', async () => {
    periods.findExpired.mockResolvedValue([budget({ id: 'a' }), budget({ id: 'b' })]);
    periods.lockBudget
      .mockResolvedValueOnce(budget({ id: 'a' }))
      .mockRejectedValueOnce(new Error('db unavailable'));

    const summary = await service.rolloverExpired(NOW);

    expect(summary).toMatchObject({ scanned: 2, rolledOver: 1, failed: 1 });
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });
});

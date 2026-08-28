import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetPeriod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { BudgetResetService, EligibleBudget } from './budget-reset.service';

const dec = (n: string) => new Prisma.Decimal(n);
const now = new Date('2026-08-28T00:00:00Z');

/** Mock helpers — typed via the PrismaService cast, not generic params. */
function createMocks() {
  const budgetFindMany = vi.fn();
  const budgetUpdateMany = vi.fn();
  const $transaction = vi.fn(
    async (cb: (tx: PrismaService) => Promise<unknown>) =>
      cb({ budget: { findMany: budgetFindMany, updateMany: budgetUpdateMany } } as unknown as PrismaService),
  );
  return { budgetFindMany, budgetUpdateMany, $transaction };
}

describe('BudgetResetService', () => {
  let budgetFindMany: ReturnType<typeof vi.fn>;
  let budgetUpdateMany: ReturnType<typeof vi.fn>;
  let $transaction: ReturnType<typeof vi.fn>;
  let eventBus: Partial<EventBusService>;
  let service: BudgetResetService;

  beforeEach(() => {
    const mocks = createMocks();
    budgetFindMany = mocks.budgetFindMany;
    budgetUpdateMany = mocks.budgetUpdateMany;
    $transaction = mocks.$transaction;

    const prisma = {
      budget: { findMany: budgetFindMany, updateMany: budgetUpdateMany },
      $transaction,
    } as unknown as PrismaService;

    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    service = new BudgetResetService(prisma, eventBus as EventBusService);
  });

  // ── calculatePeriodEnd ──────────────────────────────────────────────────

  describe('calculatePeriodEnd', () => {
    it('adds 1 day for DAILY', () => {
      const start = new Date('2026-08-28T10:00:00Z');
      const end = service.calculatePeriodEnd(start, BudgetPeriod.DAILY);
      expect(end.toISOString()).toBe('2026-08-29T10:00:00.000Z');
    });

    it('adds 7 days for WEEKLY', () => {
      const start = new Date('2026-08-28T00:00:00Z');
      const end = service.calculatePeriodEnd(start, BudgetPeriod.WEEKLY);
      expect(end.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    });

    it('adds 1 calendar month for MONTHLY', () => {
      const start = new Date('2026-01-15T00:00:00Z');
      const end = service.calculatePeriodEnd(start, BudgetPeriod.MONTHLY);
      expect(end.toISOString()).toBe('2026-02-15T00:00:00.000Z');
    });

    it('adds 3 months for QUARTERLY', () => {
      const start = new Date('2026-06-15T00:00:00Z');
      const end = service.calculatePeriodEnd(start, BudgetPeriod.QUARTERLY);
      expect(end.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    });

    it('adds 1 year for YEARLY', () => {
      const start = new Date('2025-12-31T00:00:00Z');
      const end = service.calculatePeriodEnd(start, BudgetPeriod.YEARLY);
      expect(end.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    });

    it('returns far-future date for ONE_TIME', () => {
      const end = service.calculatePeriodEnd(new Date(), BudgetPeriod.ONE_TIME);
      expect(end.getFullYear()).toBe(9999);
    });
  });

  // ── runReset ─────────────────────────────────────────────────────────────

  describe('runReset', () => {
    const makeBudget = (
      id: string,
      orgId: string,
      period: BudgetPeriod,
      periodStart: Date,
      spent: string,
    ): EligibleBudget => ({
      id,
      organizationId: orgId,
      name: `Budget ${id}`,
      period,
      periodStart,
      spent: dec(spent),
    });

    it('resets eligible monthly budgets and emits events', async () => {
      const budget = makeBudget('b1', 'org-1', BudgetPeriod.MONTHLY, new Date('2026-07-01T00:00:00Z'), '500.0000000');
      budgetFindMany
        .mockResolvedValueOnce([budget])
        .mockResolvedValueOnce([]);
      budgetUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.runReset(now);

      expect(result.totalReset).toBe(1);
      expect(result.totalFailed).toBe(0);
      expect(result.batchesProcessed).toBe(1);

      expect(budgetUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ['b1'] } }),
          data: expect.objectContaining({
            spent: expect.any(Prisma.Decimal),
            periodStart: now,
          }),
        }),
      );

      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.BudgetPeriodReset,
        expect.objectContaining({
          budgetId: 'b1',
          previousSpent: '500.0000000',
          period: BudgetPeriod.MONTHLY,
        }),
        { organizationId: 'org-1', aggregateType: 'budget', aggregateId: 'b1' },
      );
    });

    it('skips budgets whose period has not yet elapsed', async () => {
      const budget = makeBudget('b2', 'org-1', BudgetPeriod.MONTHLY, new Date('2026-08-15T00:00:00Z'), '100.0000000');
      budgetFindMany
        .mockResolvedValueOnce([budget])
        .mockResolvedValueOnce([]);

      const result = await service.runReset(now);

      expect(result.totalReset).toBe(0);
      expect(budgetUpdateMany).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('skips ONE_TIME budgets', async () => {
      const budget = makeBudget('b3', 'org-1', BudgetPeriod.ONE_TIME, new Date('2020-01-01T00:00:00Z'), '999.0000000');
      budgetFindMany
        .mockResolvedValueOnce([budget])
        .mockResolvedValueOnce([]);

      const result = await service.runReset(now);

      expect(result.totalReset).toBe(0);
      expect(budgetUpdateMany).not.toHaveBeenCalled();
    });

    it('processes multiple batches with cursor pagination', async () => {
      // Simulate BATCH_SIZE (500) worth of items in first batch to trigger pagination
      const batch1: EligibleBudget[] = [];
      for (let i = 0; i < 500; i++) {
        batch1.push(makeBudget(`b${i}`, 'org-1', BudgetPeriod.DAILY, new Date('2026-08-20T00:00:00Z'), '10.0000000'));
      }
      const batch2 = [
        makeBudget('b500', 'org-1', BudgetPeriod.DAILY, new Date('2026-08-20T00:00:00Z'), '30.0000000'),
      ];

      budgetFindMany
        .mockResolvedValueOnce(batch1)   // first batch (exactly BATCH_SIZE → continues)
        .mockResolvedValueOnce([batch2[0]])  // second batch (< BATCH_SIZE → stops)
        .mockResolvedValueOnce([]);      // safety fallback
      budgetUpdateMany.mockResolvedValue({ count: 500 });

      const result = await service.runReset(now);

      expect(result.totalReset).toBeGreaterThanOrEqual(500);
      expect(result.batchesProcessed).toBeGreaterThanOrEqual(2);
    });

    it('handles batch failures gracefully', async () => {
      const budget = makeBudget('b-fail', 'org-1', BudgetPeriod.DAILY, new Date('2026-08-26T00:00:00Z'), '50.0000000');
      budgetFindMany
        .mockResolvedValueOnce([budget])
        .mockResolvedValueOnce([]);
      budgetUpdateMany.mockRejectedValue(new Error('DB connection lost'));

      const result = await service.runReset(now);

      expect(result.totalFailed).toBe(1);
      expect(result.totalReset).toBe(0);
    });

    it('does nothing when there are no eligible budgets', async () => {
      budgetFindMany.mockResolvedValue([]);

      const result = await service.runReset(now);

      expect(result).toEqual({ totalReset: 0, totalFailed: 0, batchesProcessed: 0 });
      expect(budgetUpdateMany).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('resets daily budgets correctly', async () => {
      const budget = makeBudget('b-daily', 'org-2', BudgetPeriod.DAILY, new Date('2026-08-26T12:00:00Z'), '25.0000000');
      budgetFindMany
        .mockResolvedValueOnce([budget])
        .mockResolvedValueOnce([]);
      budgetUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.runReset(now);

      expect(result.totalReset).toBe(1);
      // periodStart 2026-08-26T12 + 1 day = 2026-08-27T12 which is <= now (2026-08-28T00)
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.BudgetPeriodReset,
        expect.objectContaining({
          budgetId: 'b-daily',
          period: BudgetPeriod.DAILY,
        }),
        expect.any(Object),
      );
    });

    it('resets quarterly budgets when period elapsed', async () => {
      const budget = makeBudget('b-q', 'org-1', BudgetPeriod.QUARTERLY, new Date('2026-04-01T00:00:00Z'), '1000.0000000');
      budgetFindMany
        .mockResolvedValueOnce([budget])
        .mockResolvedValueOnce([]);
      budgetUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.runReset(now);

      expect(result.totalReset).toBe(1);
      // Apr 1 + 3 months = Jul 1 <= Aug 28 → eligible
    });
  });
});

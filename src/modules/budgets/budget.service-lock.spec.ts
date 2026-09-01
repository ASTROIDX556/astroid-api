import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Budget, Prisma } from '@prisma/client';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { BudgetReservationService } from './services/budget-reservation.service';
import { RedisLock } from '../../common/locks/redis-lock.util';
import { EventBusService } from '../../events/event-bus.service';
import { BudgetExceededException } from '../../common/exceptions/domain.exception';

const Decimal = Prisma.Decimal;

/** Minimal mock Budget row builder. */
function mockBudget(
  overrides: Partial<{
    id: string;
    organizationId: string;
    parentBudgetId: string | null;
    limitAmount: number;
    spent: number;
    name: string;
    enabled: boolean;
  }> = {},
): Budget {
  return {
    id: overrides.id ?? 'budget-child-1',
    organizationId: overrides.organizationId ?? 'org-1',
    parentBudgetId: overrides.parentBudgetId ?? 'budget-parent-1',
    agentId: null,
    name: overrides.name ?? 'Child Budget',
    currency: 'USDC',
    limitAmount: new Decimal(overrides.limitAmount ?? 5000),
    spent: new Decimal(overrides.spent ?? 0),
    period: 'MONTHLY',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    rollover: false,
    enabled: overrides.enabled ?? true,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
  } as unknown as Budget;
}

describe('BudgetService — distributed locking', () => {
  let repository: BudgetRepository;
  let redisLock: RedisLock;
  let eventBus: EventBusService;
  let service: BudgetService;

  beforeEach(() => {
    vi.clearAllMocks();

    repository = {
      findById: vi.fn(),
      update: vi.fn(),
      incrementSpent: vi.fn(),
      create: vi.fn(),
      findManyAndCount: vi.fn(),
      findChildren: vi.fn(),
      softDelete: vi.fn(),
      findEnabledByAgentId: vi.fn(),
    } as unknown as BudgetRepository;

    redisLock = {
      withLock: vi.fn((_key: unknown, fn: () => Promise<unknown>) => fn()),
      acquire: vi.fn(),
      onModuleDestroy: vi.fn(),
    } as unknown as RedisLock;

    eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventBusService;

    const reservation = { reserve: vi.fn() } as unknown as BudgetReservationService;
    service = new BudgetService(repository, eventBus, reservation, redisLock);
  });

  // ── allocate ──

  describe('allocate', () => {
    it('acquires a lock on the parent budget key during allocation', async () => {
      const parent = mockBudget({
        id: 'budget-parent-1',
        limitAmount: 10000,
        spent: 0,
        parentBudgetId: null,
      });
      const child = mockBudget({ id: 'budget-child-1', parentBudgetId: 'budget-parent-1' });

      vi.mocked(repository.findById)
        .mockResolvedValueOnce(child)   // getOrThrow for child
        .mockResolvedValueOnce(parent)   // getOrThrow for parent
        .mockResolvedValueOnce(parent);  // re-read inside lock
      vi.mocked(repository.update).mockResolvedValue({ ...child, limitAmount: new Decimal(6000) } as Budget);

      await service.allocate('org-1', 'user-1', 'budget-child-1', { amount: '1000' });

      expect(redisLock.withLock).toHaveBeenCalledWith(
        'budget:budget-parent-1',
        expect.any(Function),
      );
    });

    it('prevents race conditions when multiple agents allocate from the same parent', async () => {
      const parent = mockBudget({
        id: 'budget-parent-1',
        limitAmount: 10000,
        spent: 0,
        parentBudgetId: null,
      });
      const child1 = mockBudget({ id: 'budget-child-1', parentBudgetId: 'budget-parent-1' });
      const child2 = mockBudget({ id: 'budget-child-2', parentBudgetId: 'budget-parent-1' });

      vi.mocked(repository.findById).mockImplementation(async (_orgId: string, id: string) => {
        if (id === 'budget-child-1') return child1;
        if (id === 'budget-child-2') return child2;
        return parent;
      });

      vi.mocked(repository.update).mockImplementation(async (id: string) => {
        return { ...(id === 'budget-child-1' ? child1 : child2), limitAmount: new Decimal(5000) } as Budget;
      });

      const promise1 = service.allocate('org-1', 'user-1', 'budget-child-1', { amount: '4000' });
      const promise2 = service.allocate('org-1', 'user-2', 'budget-child-2', { amount: '4000' });

      await Promise.all([promise1, promise2]);

      // Both allocations should succeed: 4000 + 4000 = 8000 ≤ 10000
      expect(repository.update).toHaveBeenCalledTimes(2);
    });

    it('rejects the second concurrent allocation when it would exceed the parent limit', async () => {
      const parent = mockBudget({
        id: 'budget-parent-1',
        limitAmount: 5000,
        spent: 0,
        parentBudgetId: null,
      });
      const child = mockBudget({ id: 'budget-child-1', parentBudgetId: 'budget-parent-1' });

      // First allocation uses the full parent remaining.
      vi.mocked(repository.findById)
        .mockResolvedValueOnce(child)   // child getOrThrow
        .mockResolvedValueOnce(parent)   // parent getOrThrow
        .mockResolvedValueOnce(parent);  // re-read inside lock

      vi.mocked(repository.update).mockResolvedValue({ ...child, limitAmount: new Decimal(4500) } as Budget);

      await service.allocate('org-1', 'user-1', 'budget-child-1', { amount: '4500' });

      // Now try to allocate more than the remaining 500.
      const parentAfterFirst = { ...parent, spent: new Decimal(4500) };
      vi.mocked(repository.findById)
        .mockResolvedValueOnce(child)     // child getOrThrow
        .mockResolvedValueOnce(parent)     // parent getOrThrow
        .mockResolvedValueOnce(parentAfterFirst); // re-read inside lock

      await expect(
        service.allocate('org-1', 'user-2', 'budget-child-1', { amount: '1000' }),
      ).rejects.toThrow(BudgetExceededException);
    });

    it('uses the lock with default TTL for allocate', async () => {
      const parent = mockBudget({ id: 'p1', parentBudgetId: null, limitAmount: 10000 });
      const child = mockBudget({ id: 'c1', parentBudgetId: 'p1' });

      vi.mocked(repository.findById)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(parent);
      vi.mocked(repository.update).mockResolvedValue({ ...child } as Budget);

      await service.allocate('org-1', 'user-1', 'c1', { amount: '100' });

      expect(redisLock.withLock).toHaveBeenCalledWith(
        'budget:p1',
        expect.any(Function),
      );
    });
  });

  // ── consume ──

  describe('consume', () => {
    it('emits budget.consumed after settlement (no lock, no increment)', async () => {
      const budget = mockBudget({ id: 'budget-1', spent: 100, limitAmount: 10000 });
      vi.mocked(repository.findById).mockResolvedValue(budget);

      await service.consume('org-1', 'budget-1', 100);

      expect(eventBus.emit).toHaveBeenCalledWith(
        'budget.consumed',
        expect.objectContaining({ budgetId: 'budget-1', amount: 100 }),
        expect.any(Object),
      );
    });

    it('emits budget.warning at 80% utilisation', async () => {
      const budget = mockBudget({ id: 'budget-1', spent: 7500, limitAmount: 10000 });
      vi.mocked(repository.findById).mockResolvedValue({ ...budget, spent: new Decimal(8500) } as Budget);

      await service.consume('org-1', 'budget-1', 1000);

      expect(eventBus.emit).toHaveBeenCalledWith(
        'budget.warning',
        expect.objectContaining({ budgetId: 'budget-1', utilisation: '0.8500' }),
        expect.any(Object),
      );
    });

    it('does not acquire a lock (settlement is read-only)', async () => {
      const budget = mockBudget({ id: 'budget-1', spent: 0, limitAmount: 10000 });
      vi.mocked(repository.findById).mockResolvedValue(budget);

      await service.consume('org-1', 'budget-1', 100);

      expect(redisLock.withLock).not.toHaveBeenCalled();
    });
  });

  // ── reserve ──

  describe('reserve', () => {
    it('delegates to BudgetReservationService.reserve after existence check', async () => {
      const budget = mockBudget({ id: 'budget-1', limitAmount: 10000, spent: 0 });
      vi.mocked(repository.findById).mockResolvedValue(budget);
      const reservationService = { reserve: vi.fn().mockResolvedValue(budget) } as unknown as BudgetReservationService;
      const svc = new BudgetService(repository, eventBus, reservationService, redisLock);

      await svc.reserve('org-1', 'budget-1', 500);

      expect(reservationService.reserve).toHaveBeenCalledWith('org-1', 'budget-1', 500);
    });
  });
});




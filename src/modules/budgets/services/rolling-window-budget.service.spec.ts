import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Budget, Prisma, TransactionStatus } from '@prisma/client';
import {
  ONE_DAY_MS,
  ONE_HOUR_MS,
  ONE_WEEK_MS,
  RollingWindowBudgetService,
} from './rolling-window-budget.service';
import { BudgetRepository } from '../budget.repository';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { PrismaService } from '../../../database/prisma.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { BudgetExceededException } from '../../../common/exceptions/domain.exception';

const Decimal = Prisma.Decimal;

interface MockTx {
  transaction: { aggregate: Mock };
  budget: { findMany: Mock };
}

/** Minimal mock Budget row builder — only the fields the service reads are meaningful. */
function mockBudget(
  overrides: Partial<{ id: string; organizationId: string; agentId: string; limitAmount: number; enabled: boolean }> = {},
): Budget {
  return {
    id: overrides.id ?? 'budget-1',
    organizationId: overrides.organizationId ?? 'org-1',
    parentBudgetId: null,
    agentId: overrides.agentId ?? 'agent-1',
    name: 'Test Budget',
    currency: 'USDC',
    limitAmount: new Decimal(overrides.limitAmount ?? 1000),
    spent: new Decimal(0),
    period: 'MONTHLY',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    rollover: false,
    enabled: overrides.enabled ?? true,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
  } as unknown as Budget;
}

describe('RollingWindowBudgetService', () => {
  let prisma: Partial<PrismaService>;
  let tx: MockTx;
  let budgetRepository: BudgetRepository;
  let redisLock: RedisLock;
  let eventBus: Partial<EventBusService>;
  let service: RollingWindowBudgetService;

  const NOW = new Date('2026-08-30T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    tx = {
      transaction: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }) },
      budget: { findMany: vi.fn().mockResolvedValue([]) },
    };

    prisma = {
      $transaction: vi.fn(async (cb: (t: MockTx) => Promise<unknown>) => cb(tx)),
    } as unknown as Partial<PrismaService>;

    budgetRepository = {
      findEnabledByAgentId: vi.fn(async () => [mockBudget()]),
    } as unknown as BudgetRepository;

    redisLock = {
      withLock: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as RedisLock;

    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };

    service = new RollingWindowBudgetService(
      prisma as PrismaService,
      budgetRepository,
      redisLock,
      eventBus as EventBusService,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── window helper constants ──

  it('exports sane window-size helper constants', () => {
    expect(ONE_HOUR_MS).toBe(60 * 60 * 1000);
    expect(ONE_DAY_MS).toBe(24 * ONE_HOUR_MS);
    expect(ONE_WEEK_MS).toBe(7 * ONE_DAY_MS);
  });

  // ── allow / exceed / boundary ──

  it('allows the transaction when spend + amount is within the limit', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([mockBudget({ limitAmount: 1000 })]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(400) } });

    const result = await service.checkAndReserveBudget('agent-1', 100, ONE_DAY_MS);

    expect(result.limit?.toString()).toBe('1000');
    expect(result.spentInWindow.toString()).toBe('400');
    expect(result.remainingAfter?.toString()).toBe('500');
  });

  it('throws BudgetExceededException when spend + amount exceeds the limit', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([mockBudget({ limitAmount: 1000 })]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(950) } });

    await expect(service.checkAndReserveBudget('agent-1', 100, ONE_DAY_MS)).rejects.toThrow(
      BudgetExceededException,
    );
  });

  it('emits a BudgetExceeded domain event when the limit would be breached', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([
      mockBudget({ id: 'budget-9', organizationId: 'org-9', limitAmount: 1000 }),
    ]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(950) } });

    await expect(service.checkAndReserveBudget('agent-1', 100, ONE_DAY_MS)).rejects.toThrow();

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.BudgetExceeded,
      expect.objectContaining({ budgetId: 'budget-9', agentId: 'agent-1' }),
      expect.objectContaining({ organizationId: 'org-9', aggregateId: 'budget-9' }),
    );
  });

  it('allows the transaction when spend + amount exactly equals the limit (boundary)', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([mockBudget({ limitAmount: 1000 })]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(900) } });

    const result = await service.checkAndReserveBudget('agent-1', 100, ONE_DAY_MS);

    expect(result.remainingAfter?.toString()).toBe('0');
  });

  // ── window boundary ──

  it('queries the aggregate using a window start exactly windowSizeMs before now', async () => {
    await service.checkAndReserveBudget('agent-1', 10, ONE_HOUR_MS);

    const expectedWindowStart = new Date(NOW.getTime() - ONE_HOUR_MS);
    expect(tx.transaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentId: 'agent-1',
          createdAt: { gte: expectedWindowStart },
        }),
      }),
    );
  });

  it('a transaction just inside the window is included by the query boundary', async () => {
    // The service delegates the actual row filtering to Postgres via `gte`;
    // here we confirm a transaction timestamped one millisecond inside the
    // window would satisfy the >= boundary used in the query.
    const windowSizeMs = ONE_HOUR_MS;
    const justInside = new Date(NOW.getTime() - windowSizeMs + 1);

    await service.checkAndReserveBudget('agent-1', 10, windowSizeMs);

    const [[{ where }]] = tx.transaction.aggregate.mock.calls;
    expect(justInside.getTime()).toBeGreaterThanOrEqual((where.createdAt.gte as Date).getTime());
  });

  it('a transaction just outside the window falls before the query boundary', async () => {
    const windowSizeMs = ONE_HOUR_MS;
    const justOutside = new Date(NOW.getTime() - windowSizeMs - 1);

    await service.checkAndReserveBudget('agent-1', 10, windowSizeMs);

    const [[{ where }]] = tx.transaction.aggregate.mock.calls;
    expect(justOutside.getTime()).toBeLessThan((where.createdAt.gte as Date).getTime());
  });

  // ── excluded statuses ──

  it('excludes terminal-failed statuses (FAILED, CANCELLED, REJECTED, EXPIRED) from the spend query', async () => {
    await service.checkAndReserveBudget('agent-1', 10, ONE_DAY_MS);

    expect(tx.transaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: [
              TransactionStatus.FAILED,
              TransactionStatus.CANCELLED,
              TransactionStatus.REJECTED,
              TransactionStatus.EXPIRED,
            ],
          },
        }),
      }),
    );
  });

  // ── locking / serialization ──

  it('serializes concurrent calls for the same agent via RedisLock.withLock', async () => {
    await service.checkAndReserveBudget('agent-42', 10, ONE_DAY_MS);

    expect(redisLock.withLock).toHaveBeenCalledWith('agent-budget-window:agent-42', expect.any(Function));
  });

  it('uses a distinct lock key per agent', async () => {
    await service.checkAndReserveBudget('agent-a', 10, ONE_DAY_MS);
    await service.checkAndReserveBudget('agent-b', 10, ONE_DAY_MS);

    expect(redisLock.withLock).toHaveBeenNthCalledWith(1, 'agent-budget-window:agent-a', expect.any(Function));
    expect(redisLock.withLock).toHaveBeenNthCalledWith(2, 'agent-budget-window:agent-b', expect.any(Function));
  });

  it('acquires the lock before reading the budget or the aggregate', async () => {
    const order: string[] = [];
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => {
      order.push('acquire-lock');
      const result = await fn();
      order.push('release-lock');
      return result;
    });
    vi.mocked(budgetRepository.findEnabledByAgentId).mockImplementation(async () => {
      order.push('findEnabledByAgentId');
      return [mockBudget()];
    });
    tx.transaction.aggregate.mockImplementation(async () => {
      order.push('aggregate');
      return { _sum: { amount: null } };
    });

    await service.checkAndReserveBudget('agent-1', 10, ONE_DAY_MS);

    expect(order[0]).toBe('acquire-lock');
    expect(order).toContain('findEnabledByAgentId');
    expect(order).toContain('aggregate');
    expect(order[order.length - 1]).toBe('release-lock');
  });

  // ── no budget configured ──

  it('allows the transaction and reports an unlimited window when no budget is configured for the agent', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(999999) } });

    const result = await service.checkAndReserveBudget('agent-1', 1_000_000, ONE_DAY_MS);

    expect(result.limit).toBeNull();
    expect(result.remainingAfter).toBeNull();
    expect(result.budgetId).toBeUndefined();
  });

  // ── multiple budgets: pick the most restrictive ──

  it('uses the most restrictive (smallest) limit when multiple enabled budgets exist for the agent', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([
      mockBudget({ id: 'loose', limitAmount: 5000 }),
      mockBudget({ id: 'tight', limitAmount: 200 }),
      mockBudget({ id: 'medium', limitAmount: 1000 }),
    ]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(150) } });

    await expect(service.checkAndReserveBudget('agent-1', 100, ONE_DAY_MS)).rejects.toThrow(
      BudgetExceededException,
    );

    const result = await (async () => {
      tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(50) } });
      return service.checkAndReserveBudget('agent-1', 100, ONE_DAY_MS);
    })();
    expect(result.budgetId).toBe('tight');
  });

  // ── decimal precision ──

  it('uses precise decimal arithmetic with no floating-point drift', async () => {
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([
      mockBudget({ limitAmount: 0 }),
    ]);
    // Override to a high-precision limit via a fresh Decimal (limitAmount fields are Decimal in the DB).
    const preciseBudget = mockBudget({ limitAmount: 0 });
    preciseBudget.limitAmount = new Decimal('300.3000003');
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([preciseBudget]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal('100.1000001') } });

    const result = await service.checkAndReserveBudget('agent-1', 200.2000002, ONE_DAY_MS);

    // 100.1000001 + 200.2000002 = 300.3000003, exactly equal to the limit.
    expect(result.remainingAfter?.toString()).toBe('0');
  });

  it('throws on a high-precision amount that exceeds the limit by a fraction', async () => {
    const preciseBudget = mockBudget();
    preciseBudget.limitAmount = new Decimal('300.3000003');
    vi.mocked(budgetRepository.findEnabledByAgentId).mockResolvedValue([preciseBudget]);
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal('100.1000001') } });

    await expect(
      service.checkAndReserveBudget('agent-1', 200.2000003, ONE_DAY_MS),
    ).rejects.toThrow(BudgetExceededException);
  });
});

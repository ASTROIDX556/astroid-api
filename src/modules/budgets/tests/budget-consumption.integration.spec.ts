import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BudgetService } from '../budget.service';
import { BudgetRepository } from '../budget.repository';
import { BudgetReservationService } from '../services/budget-reservation.service';
import { PolicyEvaluatorService } from '../services/policy-evaluator.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { PrismaService } from '../../../database/prisma.service';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetExceededException, ConflictException } from '../../../common/exceptions/domain.exception';

const Decimal = Prisma.Decimal;

/**
 * A tiny async mutex so the mocked Redis lock genuinely serialises the
 * critical section — the same guarantee the real `withLock` provides.
 */
function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  // Mirrors RedisLock.withLock's (key, fn, ttl) signature.
  return async <T>(_key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * In-memory budget store standing in for Postgres. `incrementSpent` simulates
 * the atomic conditional update (`UPDATE ... WHERE spent + amount <= limit`)
 * that Postgres performs, so the DB-level last line of defence is modelled
 * faithfully even when the lock is bypassed.
 */
function createStore(initial: { id: string; spent: number; limitAmount: number }) {
  const row: {
    id: string;
    organizationId: string;
    limitAmount: Prisma.Decimal;
    spent: Prisma.Decimal;
  } = {
    id: initial.id,
    organizationId: 'org-1',
    limitAmount: new Decimal(initial.limitAmount),
    spent: new Decimal(initial.spent),
  };

  return {
    get: () => ({ ...row, limitAmount: row.limitAmount, spent: row.spent }),

    findById: async () => ({ ...row, limitAmount: row.limitAmount, spent: row.spent }),

    incrementSpent: async (_id: string, amount: Prisma.Decimal) => {
      // Atomic DB precondition: refuse to increment past the limit.
      if (row.spent.plus(amount).greaterThan(row.limitAmount)) {
        throw new Prisma.PrismaClientKnownRequestError('Budget limit exceeded', {
          code: 'P2034',
          clientVersion: '5.22.0',
        });
      }
      row.spent = row.spent.plus(amount);
      return { ...row, limitAmount: row.limitAmount, spent: row.spent };
    },

    decrementSpent: async (_id: string, amount: Prisma.Decimal) => {
      row.spent = row.spent.minus(amount).isNegative() ? new Decimal(0) : row.spent.minus(amount);
      return { ...row, limitAmount: row.limitAmount, spent: row.spent };
    },
  };
}

type Store = ReturnType<typeof createStore>;

function buildService(store: Store, withLock: RedisLock['withLock']) {
  const repository = {
    findById: store.findById,
    findChildren: async () => [],
    incrementSpent: store.incrementSpent,
    decrementSpent: store.decrementSpent,
  } as unknown as BudgetRepository;

  const eventBus = { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventBusService;

  const redisLockMock = { withLock } as unknown as RedisLock;

  const reservation = new BudgetReservationService(
    repository,
    redisLockMock,
  );

  return { service: new BudgetService(repository, eventBus, reservation, redisLockMock), eventBus };
}

describe('budget consumption — integration (real service + reservation + repository)', () => {
  describe('concurrent operations under a single budget', () => {
    it('does not let concurrent agent requests overspend the budget (lock serialises)', async () => {
      const store = createStore({ id: 'budget-1', spent: 0, limitAmount: 1000 });
      const { service } = buildService(store, createMutex() as never);

      // 5 agents each try to spend 300 against a 1000 budget, concurrently.
      const attempts = Array.from({ length: 5 }, () => service.reserve('org-1', 'budget-1', 300));
      const settled = await Promise.allSettled(attempts);

      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');

      // Only 3 × 300 = 900 fits; the rest must fail safely — never 1200+.
      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(2);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededException);
      }
      expect(store.get().spent.toNumber()).toBe(900);
    });

    it('at the limit boundary exactly one of two concurrent requests wins', async () => {
      const store = createStore({ id: 'budget-1', spent: 700, limitAmount: 1000 });
      const { service } = buildService(store, createMutex() as never);

      const [a, b] = await Promise.allSettled([
        service.reserve('org-1', 'budget-1', 300),
        service.reserve('org-1', 'budget-1', 300),
      ]);

      const succeeded = [a, b].filter((r) => r.status === 'fulfilled');
      expect(succeeded).toHaveLength(1);
      expect(store.get().spent.toNumber()).toBe(1000); // never 1300
    });

    it('the DB-level atomic precondition also prevents overspend if the lock is bypassed', async () => {
      // withLock runs the section immediately — no serialisation — so only the
      // atomic conditional increment can save the budget.
      const store = createStore({ id: 'budget-1', spent: 0, limitAmount: 1000 });
      const { service } = buildService(
        store,
        (async (_key: string, fn: () => Promise<unknown>) => fn()) as never,
      );

      const attempts = Array.from({ length: 5 }, () => service.reserve('org-1', 'budget-1', 300));
      const settled = await Promise.allSettled(attempts);

      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(3);
      // Rejected attempts surface as ConflictException (lock path wraps the
      // simulated constraint error) — a typed envelope, never a silent pass.
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      }
      expect(store.get().spent.toNumber()).toBe(900);
    });
  });

  describe('precision limits (7-dp decimals)', () => {
    it('allows a spend landing exactly on the limit at 7-dp precision', async () => {
      const store = createStore({ id: 'budget-1', spent: 0.0999999, limitAmount: 0.1 });
      const { service } = buildService(store, createMutex() as never);

      const budget = await service.reserve('org-1', 'budget-1', 0.0000001);

      expect(budget.spent.toFixed(7)).toBe('0.1000000');
    });

    it('rejects a spend one 7-dp unit past the limit with exact details', async () => {
      const store = createStore({ id: 'budget-1', spent: 0.0999999, limitAmount: 0.1 });
      const { service } = buildService(store, createMutex() as never);

      await expect(service.reserve('org-1', 'budget-1', 0.0000002)).rejects.toThrow(
        BudgetExceededException,
      );
      await expect(service.reserve('org-1', 'budget-1', 0.0000002)).rejects.toMatchObject({
        details: {
          budgetId: 'budget-1',
          limit: '0.1000000',
          spent: '0.0999999',
          attempted: 0.0000002,
        },
      });
      expect(store.get().spent.toNumber()).toBe(0.0999999);
    });

    it('treats spend equal to the limit as exhausted (any positive amount fails)', async () => {
      const store = createStore({ id: 'budget-1', spent: 0.1, limitAmount: 0.1 });
      const { service } = buildService(store, createMutex() as never);

      await expect(service.reserve('org-1', 'budget-1', 0.0000001)).rejects.toThrow(
        BudgetExceededException,
      );
      // A zero-amount reservation is a no-op and never breaches the limit.
      await expect(service.reserve('org-1', 'budget-1', 0)).resolves.toBeDefined();
    });
  });

  describe('time-frame boundaries', () => {
    it('fails safely when the budget is already over its limit at the boundary', async () => {
      const store = createStore({ id: 'budget-1', spent: 1100, limitAmount: 1000 });
      const { service } = buildService(store, createMutex() as never);

      await expect(service.reserve('org-1', 'budget-1', 1)).rejects.toThrow(
        BudgetExceededException,
      );
      // Remaining is clamped at zero — clients never see a negative balance.
      const detail = await service.getDetail('org-1', 'budget-1');
      expect(detail.remaining).toBe('0.0000000');
    });

    it('emits a warning exactly at the 80% utilisation boundary, and not below it', async () => {
      const atBoundary = createStore({ id: 'budget-1', spent: 800, limitAmount: 1000 });
      const atBoundarySuite = buildService(atBoundary, createMutex() as never);

      await atBoundarySuite.service.consume('org-1', 'budget-1', 800);

      expect(atBoundarySuite.eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.BudgetWarning,
        expect.objectContaining({ budgetId: 'budget-1', utilisation: '0.8000' }),
        expect.any(Object),
      );

      const below = createStore({ id: 'budget-1', spent: 799.9999, limitAmount: 1000 });
      const belowSuite = buildService(below, createMutex() as never);

      await belowSuite.service.consume('org-1', 'budget-1', 799.9999);

      const emittedNames = vi
        .mocked(belowSuite.eventBus.emit)
        .mock.calls.map((call) => call[0]);
      expect(emittedNames).not.toContain(DomainEventName.BudgetWarning);
    });

    it('attributes daily-limit spend correctly at the exact day boundary', async () => {
      // Real PolicyEvaluatorService over a mocked Prisma: spend exactly at the
      // daily limit is allowed; one 7-dp unit over is blocked.
      const prisma = {
        policy: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'policy-1',
              name: 'Daily cap',
              enabled: true,
              agentId: null,
              priority: 100,
              configuration: { dailyLimit: 1000 },
              overrideLimit: null,
              overrideUntil: null,
              originalLimit: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
            },
          ]),
        },
        transaction: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { amount: new Decimal(1000) } }),
        },
        budget: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      const evaluator = new PolicyEvaluatorService(prisma as unknown as PrismaService);

      const allowed = await evaluator.evaluate({
        organizationId: 'org-1',
        agentId: 'agent-1',
        walletId: 'wallet-1',
        asset: 'USDC',
        amount: '0.0000000',
        recipientAddress: 'GABCDEF123456789012345678901234567890123456789012345',
      });
      expect(allowed.allowed).toBe(true);

      const blocked = await evaluator.evaluate({
        organizationId: 'org-1',
        agentId: 'agent-1',
        walletId: 'wallet-1',
        asset: 'USDC',
        amount: '0.0000001',
        recipientAddress: 'GABCDEF123456789012345678901234567890123456789012345',
      });
      expect(blocked.allowed).toBe(false);
      expect(blocked.remainingLimit).toBe('0.0000000');
    });
  });

  describe('release lifecycle (cancellation / failed execution)', () => {
    it('returns reserved headroom after a release', async () => {
      const store = createStore({ id: 'budget-1', spent: 0, limitAmount: 1000 });
      const { service } = buildService(store, createMutex() as never);

      await service.reserve('org-1', 'budget-1', 600);
      expect(store.get().spent.toNumber()).toBe(600);

      await service.release('org-1', 'budget-1', 600);
      expect(store.get().spent.toNumber()).toBe(0);

      // Headroom is restored — a new agent can spend again.
      await expect(service.reserve('org-1', 'budget-1', 600)).resolves.toBeDefined();
    });

    it('never drives spent below zero even if release exceeds the reservation', async () => {
      const store = createStore({ id: 'budget-1', spent: 100, limitAmount: 1000 });
      const { service, eventBus } = buildService(store, createMutex() as never);

      await service.release('org-1', 'budget-1', 500);

      expect(store.get().spent.toNumber()).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.BudgetReleased,
        expect.objectContaining({ amount: '100.0000000' }),
        expect.any(Object),
      );
    });
  });

  describe('reserve → consume settlement', () => {
    it('settles without double-counting the reservation', async () => {
      const store = createStore({ id: 'budget-1', spent: 0, limitAmount: 1000 });
      const { service, eventBus } = buildService(store, createMutex() as never);

      await service.reserve('org-1', 'budget-1', 300);
      await service.consume('org-1', 'budget-1', 300);

      // The reservation was booked once at reserve; consume only settles it.
      expect(store.get().spent.toNumber()).toBe(300);
      expect(eventBus.emit).toHaveBeenCalledWith(
        DomainEventName.BudgetConsumed,
        expect.objectContaining({ budgetId: 'budget-1', amount: 300, spent: '300.0000000' }),
        expect.any(Object),
      );
    });
  });
});

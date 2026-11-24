import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BudgetCarryOverRule,
  BudgetPeriod,
  BudgetReservation,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaTransactionService } from '../../database/prisma-transaction.service';
import { DEFAULT_BUDGET_ROLLOVER_CONFIG } from '../../config/budget-rollover.config';
import { RedisLock } from '../../common/locks/redis-lock.util';
import {
  BudgetExceededException,
  NotFoundException,
  ValidationException,
} from '../../common/exceptions/domain.exception';
import { EventBusService } from '../../events/event-bus.service';
import { BudgetRepository } from './budget.repository';
import { BudgetService } from './budget.service';
import { BudgetPeriodRepository } from './budget-period.repository';
import { BudgetRolloverService } from './services/budget-rollover.service';
import { getNthPeriodBounds } from './utils/period.util';

/**
 * Budget reservations against a real PostgreSQL database. A mocked Prisma
 * client cannot show that the conditional UPDATE is atomic, so these specs run
 * the real SQL through the real repository, service and rollover service.
 * Skipped without DATABASE_URL (CI's build-and-test job provides one).
 */

const databaseUrl = process.env.DATABASE_URL;
const Decimal = Prisma.Decimal;
const suffix = randomUUID();
const organizationId = `budget-race-org-${suffix}`;
const NOW = new Date('2026-06-15T12:00:00.000Z');

type Outcome = 'reserved' | 'exceeded' | 'other';

describe.skipIf(!databaseUrl)('Budget reservations (real Postgres)', () => {
  let prisma: PrismaClient;
  let repository: BudgetRepository;
  let service: BudgetService;
  let budgetCounter = 0;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl as string } } });
    await prisma.$connect();
    await prisma.organization.create({
      data: { id: organizationId, name: 'Budget race test org', slug: `budget-race-${suffix}` },
    });

    const prismaService = prisma as unknown as PrismaService;
    repository = new BudgetRepository(prismaService);
    const rollover = new BudgetRolloverService(
      new BudgetPeriodRepository(prismaService),
      new PrismaTransactionService(prismaService),
      { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventBusService,
      { get: () => DEFAULT_BUDGET_ROLLOVER_CONFIG } as never,
    );
    service = new BudgetService(
      repository,
      { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventBusService,
      {} as unknown as RedisLock,
      rollover,
    );
  }, 30_000);

  afterAll(async () => {
    if (!prisma) return;
    // Budgets, reservations and period records cascade with the organization.
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }, 30_000);

  /** A live budget whose current period contains NOW unless bounds are given. */
  async function createBudget(
    limit: number,
    options: {
      period?: BudgetPeriod;
      periodStart?: Date;
      periodEnd?: Date | null;
      timezone?: string;
    } = {},
  ): Promise<string> {
    budgetCounter += 1;
    const id = `budget-race-${suffix}-${budgetCounter}`;
    const periodStart = options.periodStart ?? new Date('2026-06-01T00:00:00.000Z');
    await prisma.budget.create({
      data: {
        id,
        organizationId,
        name: `Race budget ${budgetCounter}`,
        limitAmount: new Decimal(limit),
        period: options.period ?? BudgetPeriod.MONTHLY,
        periodStart,
        periodAnchor: periodStart,
        periodEnd: options.periodEnd === undefined ? new Date('2026-07-01T00:00:00.000Z') : options.periodEnd,
        periodIndex: 0,
        timezone: options.timezone ?? 'UTC',
        carryOverRule: BudgetCarryOverRule.NONE,
      },
    });
    return id;
  }

  const spentOf = async (budgetId: string) =>
    (await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } })).spent;

  const classify = (promise: Promise<BudgetReservation>): Promise<Outcome> =>
    promise.then(
      () => 'reserved' as const,
      (error: unknown) => (error instanceof BudgetExceededException ? 'exceeded' : 'other'),
    );

  // ── atomic consumption ────────────────────────────────────────────────────

  describe('concurrent consumption', () => {
    it('lets exactly the reservations that fit succeed: limit 100, ten parallel 40s → two', async () => {
      const budgetId = await createBudget(100);
      const limit = new Decimal(100);

      // Sample the stored total while the race runs: spent <= limit must hold
      // at every observable moment, not only at the end.
      let racing = true;
      const samples: Prisma.Decimal[] = [];
      const sampler = (async () => {
        while (racing) {
          samples.push(await spentOf(budgetId));
        }
      })();

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => classify(service.reserveAtomic(organizationId, budgetId, 40, NOW))),
      );
      racing = false;
      await sampler;

      expect(outcomes.filter((o) => o === 'reserved')).toHaveLength(2);
      expect(outcomes.filter((o) => o === 'exceeded')).toHaveLength(8);
      expect(outcomes.filter((o) => o === 'other')).toHaveLength(0);

      const spent = await spentOf(budgetId);
      expect(spent.toString()).toBe('80');
      expect(spent.lessThanOrEqualTo(limit)).toBe(true);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((sample) => sample.lessThanOrEqualTo(limit))).toBe(true);

      const held = await prisma.budgetReservation.findMany({ where: { budgetId } });
      expect(held).toHaveLength(2);
      expect(held.every((r) => r.status === ReservationStatus.PENDING)).toBe(true);
      expect(held.reduce((sum, r) => sum.plus(r.amount), new Decimal(0)).toString()).toBe('80');
    }, 30_000);

    it('lets every reservation succeed when they all fit (no spurious serialization failures)', async () => {
      const budgetId = await createBudget(1_000);

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => classify(service.reserveAtomic(organizationId, budgetId, 40, NOW))),
      );

      expect(outcomes).toEqual(Array(10).fill('reserved'));
      expect((await spentOf(budgetId)).toString()).toBe('400');
    }, 30_000);

    it('holds the limit across different agents, whose per-agent locks do not serialise each other', async () => {
      const budgetId = await createBudget(100);
      // Each agent's submissions run one after another (as under the per-agent
      // spend-enforcement lock); the agents themselves race each other.
      const chains = new Map<string, Promise<unknown>>();
      const submit = (agentId: string) => {
        const previous = chains.get(agentId) ?? Promise.resolve();
        const next = previous.then(() => classify(service.reserveAtomic(organizationId, budgetId, 40, NOW)));
        chains.set(agentId, next.catch(() => undefined));
        return next;
      };

      const outcomes = await Promise.all(
        ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e'].flatMap((agent) => [submit(agent), submit(agent)]),
      );

      expect(outcomes.filter((o) => o === 'reserved')).toHaveLength(2);
      expect(outcomes.filter((o) => o === 'exceeded')).toHaveLength(8);
      expect((await spentOf(budgetId)).toString()).toBe('80');
    }, 30_000);

    it('accepts an amount exactly equal to the remaining budget and nothing beyond it', async () => {
      const budgetId = await createBudget(100);

      await service.reserveAtomic(organizationId, budgetId, 60, NOW);
      await service.reserveAtomic(organizationId, budgetId, 40, NOW);
      expect((await spentOf(budgetId)).toString()).toBe('100');

      await expect(service.reserveAtomic(organizationId, budgetId, 0.0000001, NOW)).rejects.toBeInstanceOf(
        BudgetExceededException,
      );
      expect((await spentOf(budgetId)).toString()).toBe('100');
    }, 30_000);

    it('rejects zero and negative amounts without touching spent', async () => {
      const budgetId = await createBudget(100);

      await expect(service.reserveAtomic(organizationId, budgetId, 0, NOW)).rejects.toBeInstanceOf(ValidationException);
      await expect(service.reserveAtomic(organizationId, budgetId, -50, NOW)).rejects.toBeInstanceOf(ValidationException);

      expect((await spentOf(budgetId)).toString()).toBe('0');
      expect(await prisma.budgetReservation.count({ where: { budgetId } })).toBe(0);
    }, 30_000);

    it('reports a missing or foreign budget as not found', async () => {
      const budgetId = await createBudget(100);

      await expect(service.reserveAtomic(organizationId, `missing-${suffix}`, 10, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.reserveAtomic(`other-org-${suffix}`, budgetId, 10, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((await spentOf(budgetId)).toString()).toBe('0');
    }, 30_000);
  });

  // ── reservation lifecycle ─────────────────────────────────────────────────

  describe('settle and release', () => {
    it('returns the hold when a transaction fails or is rejected', async () => {
      const budgetId = await createBudget(100);
      const reservation = await service.reserveAtomic(organizationId, budgetId, 40, NOW);

      const released = await service.release(reservation.id);

      expect(released.status).toBe(ReservationStatus.RELEASED);
      expect((await spentOf(budgetId)).toString()).toBe('0');
    }, 30_000);

    it('refunds once when the same reservation is released concurrently (double failure / retried job)', async () => {
      const budgetId = await createBudget(100);
      await service.reserveAtomic(organizationId, budgetId, 30, NOW);
      const reservation = await service.reserveAtomic(organizationId, budgetId, 40, NOW);

      await Promise.all([service.release(reservation.id), service.release(reservation.id), service.release(reservation.id)]);
      await service.release(reservation.id);

      expect((await spentOf(budgetId)).toString()).toBe('30');
    }, 30_000);

    it('counts the spend once when a retried execution settles the same reservation twice', async () => {
      const budgetId = await createBudget(100);
      const reservation = await service.reserveAtomic(organizationId, budgetId, 40, NOW);

      await Promise.all([
        repository.settleReservation(reservation.id, new Decimal(40)),
        repository.settleReservation(reservation.id, new Decimal(40)),
      ]);

      expect((await spentOf(budgetId)).toString()).toBe('40');
      const stored = await prisma.budgetReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.status).toBe(ReservationStatus.SETTLED);
    }, 30_000);

    it('records real spend when a released reservation is settled after money moved', async () => {
      const budgetId = await createBudget(100);
      const reservation = await service.reserveAtomic(organizationId, budgetId, 40, NOW);
      await service.release(reservation.id);

      await repository.settleReservation(reservation.id, new Decimal(40));

      expect((await spentOf(budgetId)).toString()).toBe('40');
    }, 30_000);

    it('ends consistent when a settle and a release race on the same reservation', async () => {
      const budgetId = await createBudget(100);
      const reservation = await service.reserveAtomic(organizationId, budgetId, 40, NOW);

      await Promise.all([
        repository.settleReservation(reservation.id, new Decimal(40)),
        service.release(reservation.id),
      ]);

      // Either order ends with the payment counted exactly once.
      expect((await spentOf(budgetId)).toString()).toBe('40');
      const stored = await prisma.budgetReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.status).toBe(ReservationStatus.SETTLED);
    }, 30_000);

    it('releases nothing for an unknown reservation', async () => {
      await expect(service.release(`missing-${suffix}`)).rejects.toMatchObject({ code: 'P2025' });
    }, 30_000);
  });

  // ── periods ───────────────────────────────────────────────────────────────

  describe.each([
    { period: BudgetPeriod.DAILY, anchor: new Date('2026-06-10T00:00:00.000Z'), timezone: 'UTC' },
    { period: BudgetPeriod.WEEKLY, anchor: new Date('2026-06-08T00:00:00.000Z'), timezone: 'UTC' },
    // Lagos is UTC+1: the monthly boundary is local midnight, 23:00 UTC.
    { period: BudgetPeriod.MONTHLY, anchor: new Date('2026-05-31T23:00:00.000Z'), timezone: 'Africa/Lagos' },
  ])('$period period rollover with a fixed clock', ({ period, anchor, timezone }) => {
    it('resets spend on the boundary and never lets an old-period hold touch the new period', async () => {
      const current = getNthPeriodBounds(period, anchor, timezone, 0);
      const next = getNthPeriodBounds(period, anchor, timezone, 1);
      const budgetId = await createBudget(100, {
        period,
        periodStart: current.start,
        periodEnd: current.end,
        timezone,
      });
      const justBefore = new Date(current.end.getTime() - 1_000);

      // Spend near the end of the period.
      const old = await service.reserveAtomic(organizationId, budgetId, 70, justBefore);
      expect(old.periodStart?.toISOString()).toBe(current.start.toISOString());
      // A legacy hold (no recorded period) taken in the same period.
      const legacy = await prisma.budgetReservation.create({
        data: {
          budgetId,
          organizationId,
          amount: new Decimal(10),
          status: ReservationStatus.PENDING,
          createdAt: justBefore,
        },
      });
      await prisma.budget.update({ where: { id: budgetId }, data: { spent: { increment: 10 } } });
      await expect(service.reserveAtomic(organizationId, budgetId, 30, justBefore)).rejects.toBeInstanceOf(
        BudgetExceededException,
      );

      // Exactly on the boundary the new period starts; the scheduled rollover
      // has not run, so the reservation rolls the budget over itself.
      const fresh = await service.reserveAtomic(organizationId, budgetId, 50, current.end);
      expect(fresh.periodStart?.toISOString()).toBe(next.start.toISOString());

      const rolled = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } });
      expect(rolled.periodStart.toISOString()).toBe(next.start.toISOString());
      expect(rolled.spent.toString()).toBe('50');
      const closed = await prisma.budgetPeriodRecord.findUniqueOrThrow({
        where: { budgetId_periodStart: { budgetId, periodStart: current.start } },
      });
      expect(closed.finalSpent?.toString()).toBe('80');

      // Releasing holds from the closed period never reduces the new period.
      await service.release(old.id);
      await service.release(legacy.id);
      expect((await spentOf(budgetId)).toString()).toBe('50');
      expect(
        (await prisma.budgetReservation.findUniqueOrThrow({ where: { id: old.id } })).status,
      ).toBe(ReservationStatus.RELEASED);

      // The new period has its own full limit: exactly the remaining 50 fits.
      const afterBoundary = new Date(current.end.getTime() + 1_000);
      await expect(service.reserveAtomic(organizationId, budgetId, 50.0000001, afterBoundary)).rejects.toBeInstanceOf(
        BudgetExceededException,
      );
      await service.reserveAtomic(organizationId, budgetId, 50, afterBoundary);
      expect((await spentOf(budgetId)).toString()).toBe('100');

      // Releasing a new-period hold does return it to the new period.
      await service.release(fresh.id);
      expect((await spentOf(budgetId)).toString()).toBe('50');
    }, 30_000);
  });
});

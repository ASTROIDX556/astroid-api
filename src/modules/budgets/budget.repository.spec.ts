import { describe, expect, it, vi } from 'vitest';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { BudgetRepository, BudgetReservationError } from './budget.repository';

const Decimal = Prisma.Decimal;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');

/** The SQL text of a tagged-template call, placeholders included. */
function sqlOf(call: unknown[]): string {
  const [strings] = call as [TemplateStringsArray | Prisma.Sql];
  return 'strings' in strings ? strings.strings.join('?') : (strings as TemplateStringsArray).join('?');
}

/** A Prisma stand-in whose `$transaction(fn)` runs `fn` on `tx`. */
function setup(tx: Record<string, unknown>) {
  const prisma = {
    $transaction: vi.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, repository: new BudgetRepository(prisma as unknown as PrismaService) };
}

describe('BudgetRepository.createReservation', () => {
  function reservationTx(updatedRows: Array<{ periodStart: Date }>, budget: { periodEnd: Date | null } | null = null) {
    return {
      $queryRaw: vi.fn().mockResolvedValue(updatedRows),
      budget: { findFirst: vi.fn().mockResolvedValue(budget) },
      budgetReservation: {
        create: vi.fn(async ({ data }: { data: object }) => ({ id: 'rsv-1', ...data })),
      },
    };
  }

  it('checks and increments in one conditional UPDATE, then records the hold in the same transaction', async () => {
    const tx = reservationTx([{ periodStart: PERIOD_START }]);
    const { prisma, repository } = setup(tx);

    const reservation = await repository.createReservation('org-1', 'budget-1', new Decimal(40), NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Default (READ COMMITTED) isolation: no serialization aborts under contention.
    expect(prisma.$transaction.mock.calls[0]).toHaveLength(1);
    const sql = sqlOf(tx.$queryRaw.mock.calls[0]);
    expect(sql).toMatch(/UPDATE "budgets"\s+SET "spent" = "spent" \+ \?/);
    expect(sql).toContain('AND "spent" + ? <= "limitAmount"');
    expect(sql).toContain('"organizationId" = ?');
    expect(sql).toContain('"deletedAt" IS NULL');
    expect(sql).toContain('("periodEnd" IS NULL OR "periodEnd" > ?)');
    expect(sql).toContain('RETURNING "periodStart"');
    expect(tx.$queryRaw.mock.calls[0]).toContainEqual(new Decimal(40));

    expect(tx.budgetReservation.create).toHaveBeenCalledWith({
      data: {
        budgetId: 'budget-1',
        organizationId: 'org-1',
        amount: new Decimal(40),
        status: ReservationStatus.PENDING,
        periodStart: PERIOD_START,
      },
    });
    expect(reservation).toMatchObject({ id: 'rsv-1', periodStart: PERIOD_START });
  });

  it.each([
    ['zero', new Decimal(0)],
    ['negative', new Decimal(-5)],
    ['not a number', new Decimal(NaN)],
  ])('rejects a %s amount before touching the database', async (_label, amount) => {
    const tx = reservationTx([{ periodStart: PERIOD_START }]);
    const { prisma, repository } = setup(tx);

    await expect(repository.createReservation('org-1', 'budget-1', amount, NOW)).rejects.toMatchObject({
      reason: 'InvalidAmount',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports BudgetExceeded when the budget exists, its period is live and nothing was updated', async () => {
    const tx = reservationTx([], { periodEnd: new Date('2026-07-01T00:00:00.000Z') });
    const { repository } = setup(tx);

    const error = await repository
      .createReservation('org-1', 'budget-1', new Decimal(40), NOW)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetReservationError);
    expect(error).toMatchObject({ reason: 'BudgetExceeded', message: 'BudgetExceeded' });
    expect(tx.budgetReservation.create).not.toHaveBeenCalled();
  });

  it('reports BudgetExceeded for a ONE_TIME budget (no period end)', async () => {
    const { repository } = setup(reservationTx([], { periodEnd: null }));

    await expect(repository.createReservation('org-1', 'budget-1', new Decimal(40), NOW)).rejects.toMatchObject({
      reason: 'BudgetExceeded',
    });
  });

  it('reports BudgetPeriodElapsed when the current period ended at or before now', async () => {
    const { repository } = setup(reservationTx([], { periodEnd: NOW }));

    await expect(repository.createReservation('org-1', 'budget-1', new Decimal(40), NOW)).rejects.toMatchObject({
      reason: 'BudgetPeriodElapsed',
    });
  });

  it('reports NotFoundException when no live budget belongs to the organization', async () => {
    const tx = reservationTx([], null);
    const { repository } = setup(tx);

    await expect(repository.createReservation('org-1', 'budget-1', new Decimal(40), NOW)).rejects.toMatchObject({
      reason: 'NotFoundException',
    });
    expect(tx.budget.findFirst).toHaveBeenCalledWith({
      where: { id: 'budget-1', organizationId: 'org-1', deletedAt: null },
      select: { periodEnd: true },
    });
  });
});

describe('BudgetRepository.releaseReservation and settleReservation', () => {
  function lifecycleTx(row: {
    status: ReservationStatus;
    amount?: number;
    periodStart?: Date | null;
    createdAt?: Date;
  }) {
    return {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'rsv-1',
          budgetId: 'budget-1',
          amount: new Decimal(row.amount ?? 40),
          status: row.status,
          periodStart: row.periodStart === undefined ? PERIOD_START : row.periodStart,
          createdAt: row.createdAt ?? NOW,
        },
      ]),
      budget: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      budgetReservation: {
        update: vi.fn(async ({ data }: { data: object }) => ({ id: 'rsv-1', ...data })),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'rsv-1', status: row.status }),
      },
    };
  }

  it('locks the reservation row before deciding', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.PENDING });
    const { repository } = setup(tx);

    await repository.releaseReservation('rsv-1');

    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toMatch(/FROM "budget_reservations"\s+WHERE "id" = \?\s+FOR UPDATE/);
  });

  it('returns a PENDING hold to spend only while the budget is still in its period', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.PENDING });
    const { repository } = setup(tx);

    await repository.releaseReservation('rsv-1');

    expect(tx.budget.updateMany).toHaveBeenCalledWith({
      where: { id: 'budget-1', periodStart: PERIOD_START },
      data: { spent: { increment: new Decimal(-40) } },
    });
    expect(tx.budgetReservation.update).toHaveBeenCalledWith({
      where: { id: 'rsv-1' },
      data: { status: ReservationStatus.RELEASED },
    });
  });

  it('matches a legacy hold (no recorded period) to the current period by its creation time', async () => {
    const createdAt = new Date('2026-06-10T00:00:00.000Z');
    const tx = lifecycleTx({ status: ReservationStatus.PENDING, periodStart: null, createdAt });
    const { repository } = setup(tx);

    await repository.releaseReservation('rsv-1');

    expect(tx.budget.updateMany).toHaveBeenCalledWith({
      where: { id: 'budget-1', periodStart: { lte: createdAt } },
      data: { spent: { increment: new Decimal(-40) } },
    });
  });

  it.each([ReservationStatus.RELEASED, ReservationStatus.SETTLED])(
    'does not refund a %s reservation again',
    async (status) => {
      const tx = lifecycleTx({ status });
      const { repository } = setup(tx);

      await repository.releaseReservation('rsv-1');

      expect(tx.budget.updateMany).not.toHaveBeenCalled();
      expect(tx.budgetReservation.update).not.toHaveBeenCalled();
    },
  );

  it('throws P2025 for an unknown reservation', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.PENDING });
    tx.$queryRaw.mockResolvedValue([]);
    const { repository } = setup(tx);

    await expect(repository.releaseReservation('missing')).rejects.toMatchObject({ code: 'P2025' });
  });

  it('settles a PENDING hold by applying only the actual-minus-reserved delta', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.PENDING, amount: 50 });
    const { repository } = setup(tx);

    await repository.settleReservation('rsv-1', new Decimal(45));

    expect(tx.budget.updateMany).toHaveBeenCalledWith({
      where: { id: 'budget-1', periodStart: PERIOD_START },
      data: { spent: { increment: new Decimal(-5) } },
    });
    expect(tx.budgetReservation.update).toHaveBeenCalledWith({
      where: { id: 'rsv-1' },
      data: { status: ReservationStatus.SETTLED, settledAmount: new Decimal(45) },
    });
  });

  it('does not touch spend when the actual amount equals the reserved amount', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.PENDING, amount: 40 });
    const { repository } = setup(tx);

    await repository.settleReservation('rsv-1', new Decimal(40));

    expect(tx.budget.updateMany).not.toHaveBeenCalled();
  });

  it('re-records the full actual amount when settling a RELEASED hold (money moved)', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.RELEASED, amount: 40 });
    const { repository } = setup(tx);

    await repository.settleReservation('rsv-1', new Decimal(40));

    expect(tx.budget.updateMany).toHaveBeenCalledWith({
      where: { id: 'budget-1', periodStart: PERIOD_START },
      data: { spent: { increment: new Decimal(40) } },
    });
  });

  it('is a no-op for an already SETTLED reservation', async () => {
    const tx = lifecycleTx({ status: ReservationStatus.SETTLED });
    const { repository } = setup(tx);

    await repository.settleReservation('rsv-1', new Decimal(40));

    expect(tx.budget.updateMany).not.toHaveBeenCalled();
    expect(tx.budgetReservation.update).not.toHaveBeenCalled();
  });
});

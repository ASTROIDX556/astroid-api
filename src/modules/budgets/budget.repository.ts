import { Injectable } from '@nestjs/common';
import { Budget, BudgetReservation, Prisma, ReservationStatus, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

type BudgetQueryClient = Pick<PrismaService, 'budget'> | Prisma.TransactionClient;

/** Why a reservation could not be taken. */
export type BudgetReservationFailure =
  /** The budget does not exist for the organization (or is deleted). */
  | 'NotFoundException'
  /** The reservation would take `spent` above `limitAmount`. */
  | 'BudgetExceeded'
  /** The budget's current period has ended and has not been rolled over yet. */
  | 'BudgetPeriodElapsed'
  /** Zero, negative or non-finite amount. */
  | 'InvalidAmount';

/**
 * Raised by {@link BudgetRepository.createReservation}. The message equals the
 * reason, so existing `error.message` checks keep working.
 */
export class BudgetReservationError extends Error {
  constructor(readonly reason: BudgetReservationFailure) {
    super(reason);
    this.name = 'BudgetReservationError';
  }
}

/**
 * A timestamp as a `timestamp(3)` value in UTC, for raw SQL. Prisma stores
 * `DateTime` as UTC wall-clock time in `timestamp without time zone` columns;
 * casting an ISO string through `timestamptz` and back to UTC makes the
 * comparison independent of the session's `TimeZone` setting.
 */
function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

@Injectable()
export class BudgetRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.BudgetCreateInput): Promise<Budget> {
    return this.prisma.budget.create({ data });
  }

  async findManyAndCount(where: Prisma.BudgetWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.budget.findMany({ where, ...pagination }),
      this.prisma.budget.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Budget | null> {
    return this.prisma.budget.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  findChildren(parentBudgetId: string): Promise<Budget[]> {
    return this.prisma.budget.findMany({
      where: { parentBudgetId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  update(id: string, data: Prisma.BudgetUpdateInput): Promise<Budget> {
    return this.prisma.budget.update({ where: { id }, data });
  }

  incrementSpent(id: string, amount: Prisma.Decimal): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { spent: { increment: amount } },
    });
  }

  softDelete(id: string): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }

  findEnabledByAgentId(
    agentId: string,
    client: BudgetQueryClient = this.prisma,
    organizationId?: string,
  ): Promise<Budget[]> {
    return client.budget.findMany({
      where: { agentId, ...(organizationId ? { organizationId } : {}), enabled: true, deletedAt: null },
    });
  }

  async sumUnaccountedSpendByAgent(
    agentId: string,
    organizationId: string,
    asset: string,
    accountedBudgetIds: string[],
  ) {
    const result = await this.prisma.transaction.aggregate({
      where: {
        agentId,
        organizationId,
        asset,
        deletedAt: null,
        OR: [
          {
            status: {
              in: [
                TransactionStatus.DRAFT,
                TransactionStatus.PENDING,
                TransactionStatus.APPROVED,
                TransactionStatus.SUBMITTED,
                TransactionStatus.CONFIRMED,
              ],
            },
          },
          { status: TransactionStatus.COMPLETED, budgetId: null },
          {
            status: TransactionStatus.COMPLETED,
            budgetId: { notIn: accountedBudgetIds },
          },
        ],
      },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  // ── atomic reservation ──────────────────────────────────────────────────

  /**
   * Atomically takes a reservation: one conditional UPDATE checks the limit and
   * increments `spent` in a single statement, then the reservation row is
   * inserted in the same transaction (both commit, or neither does).
   *
   * The UPDATE matches only when the budget belongs to the organization, is not
   * deleted, its current period is still live (`periodEnd` is null or in the
   * future at `now`), and `spent + amount <= limitAmount` — so an amount equal to
   * the remaining balance succeeds. The arithmetic and the check never leave
   * Postgres: concurrent callers queue on the row lock and each re-evaluates the
   * WHERE clause against the latest committed `spent` (READ COMMITTED), so at
   * most the amounts that fit succeed, without serialization aborts.
   *
   * The reservation records the period it was taken in (`periodStart`, returned
   * by the UPDATE itself), which later decides whether a settle or release may
   * touch `spent`.
   *
   * @throws BudgetReservationError `InvalidAmount` | `NotFoundException` |
   *   `BudgetPeriodElapsed` | `BudgetExceeded`
   */
  async createReservation(
    organizationId: string,
    budgetId: string,
    amount: Prisma.Decimal,
    now: Date = new Date(),
  ): Promise<BudgetReservation> {
    // Validation already rejects these upstream; the repository stays defensive
    // because a negative amount would otherwise *lower* `spent`.
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
      throw new BudgetReservationError('InvalidAmount');
    }

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ periodStart: Date }>>`
        UPDATE "budgets"
        SET "spent" = "spent" + ${amount},
            "updatedAt" = NOW()
        WHERE "id" = ${budgetId}
          AND "organizationId" = ${organizationId}
          AND "deletedAt" IS NULL
          AND ("periodEnd" IS NULL OR "periodEnd" > ${utcTimestamp(now)})
          AND "spent" + ${amount} <= "limitAmount"
        RETURNING "periodStart"
      `;

      if (rows.length === 0) {
        // Nothing was written; work out why for typed error mapping.
        const budget = await tx.budget.findFirst({
          where: { id: budgetId, organizationId, deletedAt: null },
          select: { periodEnd: true },
        });
        if (!budget) throw new BudgetReservationError('NotFoundException');
        if (budget.periodEnd && budget.periodEnd.getTime() <= now.getTime()) {
          throw new BudgetReservationError('BudgetPeriodElapsed');
        }
        throw new BudgetReservationError('BudgetExceeded');
      }

      return tx.budgetReservation.create({
        data: {
          budgetId,
          organizationId,
          amount,
          status: ReservationStatus.PENDING,
          periodStart: rows[0].periodStart,
        },
      });
    });
  }

  /**
   * Settles a reservation once the payment has gone through. Idempotent: a
   * SETTLED reservation is returned unchanged.
   *
   * - PENDING: `spent` already holds the reserved amount, so only the delta
   *   between the actual and the reserved amount is applied.
   * - RELEASED: the hold was returned, but money did move, so the full actual
   *   amount is recorded again (real spend is never left uncounted).
   *
   * Either adjustment applies only while the budget is still in the period the
   * reservation was taken in; a closed period's spend is already snapshotted.
   */
  async settleReservation(
    reservationId: string,
    actualAmount: Prisma.Decimal,
  ): Promise<BudgetReservation> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await this.lockReservation(tx, reservationId);
      if (reservation.status === ReservationStatus.SETTLED) {
        return tx.budgetReservation.findUniqueOrThrow({ where: { id: reservationId } });
      }

      const adjustment =
        reservation.status === ReservationStatus.RELEASED
          ? actualAmount
          : actualAmount.minus(reservation.amount);
      await this.adjustSpentInReservationPeriod(tx, reservation, adjustment);

      return tx.budgetReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.SETTLED, settledAmount: actualAmount },
      });
    });
  }

  /**
   * Releases a held reservation after a rejected, failed or cancelled
   * transaction. Idempotent: only a PENDING reservation is released, so a
   * retried or concurrent release returns the row without refunding twice.
   * The held amount goes back to `spent` only while the budget is still in the
   * reservation's period; releasing a hold from a closed period never reduces
   * the new period's spend.
   */
  async releaseReservation(reservationId: string): Promise<BudgetReservation> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await this.lockReservation(tx, reservationId);
      if (reservation.status !== ReservationStatus.PENDING) {
        return tx.budgetReservation.findUniqueOrThrow({ where: { id: reservationId } });
      }

      await this.adjustSpentInReservationPeriod(tx, reservation, reservation.amount.negated());

      return tx.budgetReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.RELEASED },
      });
    });
  }

  /**
   * Locks the reservation row for the rest of the transaction, so a settle and
   * a release (or two of either) on the same reservation run one after the
   * other and the second sees the first one's status.
   */
  private async lockReservation(
    tx: Prisma.TransactionClient,
    reservationId: string,
  ): Promise<Pick<BudgetReservation, 'id' | 'budgetId' | 'amount' | 'status' | 'periodStart' | 'createdAt'>> {
    const rows = await tx.$queryRaw<
      Array<Pick<BudgetReservation, 'id' | 'budgetId' | 'amount' | 'status' | 'periodStart' | 'createdAt'>>
    >`
      SELECT "id", "budgetId", "amount", "status", "periodStart", "createdAt"
      FROM "budget_reservations"
      WHERE "id" = ${reservationId}
      FOR UPDATE
    `;
    const reservation = rows[0];
    if (!reservation) {
      throw new Prisma.PrismaClientKnownRequestError(`Budget reservation '${reservationId}' not found`, {
        code: 'P2025',
        clientVersion: Prisma.prismaVersion.client,
      });
    }
    return { ...reservation, amount: new Prisma.Decimal(reservation.amount) };
  }

  /**
   * Adds `delta` to `spent` only if the budget is still in the reservation's
   * period. Holds created before `periodStart` was recorded count as current
   * when they were made at or after the budget's current period start.
   */
  private async adjustSpentInReservationPeriod(
    tx: Prisma.TransactionClient,
    reservation: Pick<BudgetReservation, 'budgetId' | 'periodStart' | 'createdAt'>,
    delta: Prisma.Decimal,
  ): Promise<void> {
    if (delta.isZero()) return;
    await tx.budget.updateMany({
      where: {
        id: reservation.budgetId,
        ...(reservation.periodStart
          ? { periodStart: reservation.periodStart }
          : { periodStart: { lte: reservation.createdAt } }),
      },
      data: { spent: { increment: delta } },
    });
  }

  /**
   * Sum of PENDING (held, not yet settled or released) reservations per
   * budget. Budgets with no pending reservation are absent from the map.
   */
  async sumPendingReservations(budgetIds: string[]): Promise<Map<string, Prisma.Decimal>> {
    if (budgetIds.length === 0) return new Map();
    const rows = await this.prisma.budgetReservation.groupBy({
      by: ['budgetId'],
      where: { budgetId: { in: budgetIds }, status: ReservationStatus.PENDING },
      _sum: { amount: true },
    });
    return new Map(
      rows.map((row) => [row.budgetId, new Prisma.Decimal(row._sum.amount ?? 0)]),
    );
  }

  findReservationById(id: string): Promise<BudgetReservation | null> {
    return this.prisma.budgetReservation.findUnique({ where: { id } });
  }
}

import { Injectable } from '@nestjs/common';
import { Budget, BudgetReservation, Prisma, ReservationStatus, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

type BudgetQueryClient = Pick<PrismaService, 'budget'> | Prisma.TransactionClient;

/**
 * Client accepted by the multi-statement writes below. Defaults to the shared
 * {@link PrismaService}, but callers running inside a
 * `PrismaTransactionService` unit of work pass the transactional client so the
 * row lock and the update commit or roll back together.
 */
type BudgetWriteClient = PrismaService | Prisma.TransactionClient;

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

  /**
   * Locks the budget row (`SELECT … FOR UPDATE`), verifies the reservation fits
   * inside the remaining balance, and applies it — all on `client`.
   *
   * Pass a `Prisma.TransactionClient` to join an existing unit of work; the
   * default keeps this method usable standalone. Note that the lock only
   * protects the caller when it runs inside that transaction, which is why
   * `BudgetService.reserveBudget` always wraps it in one.
   *
   * @throws Error with `NotFoundException` when the budget does not belong to
   * the organization, or `ConflictException: BudgetExceeded` when the
   * reservation would overshoot the limit.
   */
  async reserveBudget(
    organizationId: string,
    id: string,
    amount: Prisma.Decimal,
    client: BudgetWriteClient = this.prisma,
  ): Promise<Budget> {
    const rows = await client.$queryRaw<Budget[]>`SELECT * FROM "budgets" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (!rows || rows.length === 0) {
      throw new Error('NotFoundException');
    }

    const budget = rows[0];
    const spentAfter = new Prisma.Decimal(budget.spent).plus(amount);
    const limit = new Prisma.Decimal(budget.limitAmount);

    if (spentAfter.greaterThan(limit)) {
      throw new Error('ConflictException: BudgetExceeded');
    }

    return client.budget.update({
      where: { id },
      data: { spent: spentAfter },
    });
  }

  /**
   * Releases a held budget reservation by decrementing spent atomically.
   */
  async releaseBudget(
    organizationId: string,
    id: string,
    amount: Prisma.Decimal,
    client: BudgetWriteClient = this.prisma,
  ): Promise<Budget> {
    const rows = await client.$queryRaw<Budget[]>`SELECT * FROM "budgets" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (!rows || rows.length === 0) {
      throw new Error('NotFoundException');
    }

    const budget = rows[0];
    const diff = new Prisma.Decimal(budget.spent).minus(amount);
    const spentAfter = diff.isNegative() ? new Prisma.Decimal(0) : diff;

    return client.budget.update({
      where: { id },
      data: { spent: spentAfter },
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
   * Atomically creates a reservation and increments `spent` by `amount` using a
   * conditional `UPDATE … WHERE limitAmount - spent >= amount`. The
   * UPDATE runs first inside a serializable transaction; if it matches zero
   * rows the budget is at or over its limit and the reservation is rejected
   * before any INSERT happens.
   *
   * Keeping the arithmetic in the database (not JS) means two concurrent
   * callers that both read the same remaining balance cannot both succeed —
   * only the one whose UPDATE lands first will match the WHERE condition.
   *
   * @throws Error('NotFoundException')   – budget not found for org
   * @throws Error('BudgetExceeded')      – reservation would exceed the limit
   */
  async createReservation(
    organizationId: string,
    budgetId: string,
    amount: Prisma.Decimal,
  ): Promise<BudgetReservation> {
    return this.prisma.$transaction(async (tx) => {
      // Conditional atomic deduct: only succeeds when remaining >= amount.
      const updated = await tx.$executeRaw`
        UPDATE "budgets"
        SET "spent" = "spent" + ${amount},
            "updatedAt" = NOW()
        WHERE "id" = ${budgetId}
          AND "organizationId" = ${organizationId}
          AND "deletedAt" IS NULL
          AND ("limitAmount" - "spent") >= ${amount}
      `;

      if (updated === 0) {
        // Distinguish not-found from over-budget for typed error mapping.
        const exists = await tx.budget.findFirst({
          where: { id: budgetId, organizationId, deletedAt: null },
          select: { id: true },
        });
        if (!exists) throw new Error('NotFoundException');
        throw new Error('BudgetExceeded');
      }

      return tx.budgetReservation.create({
        data: {
          budgetId,
          organizationId,
          amount,
          status: ReservationStatus.PENDING,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Settles a reservation — adjusts `spent` by the delta between the actual
   * amount and the reserved amount, then marks the row SETTLED. Idempotent:
   * a row already SETTLED is returned unchanged without touching `spent`.
   */
  async settleReservation(
    reservationId: string,
    actualAmount: Prisma.Decimal,
  ): Promise<BudgetReservation> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.budgetReservation.findUniqueOrThrow({
        where: { id: reservationId },
      });
      if (reservation.status === ReservationStatus.SETTLED) return reservation;

      const delta = actualAmount.minus(reservation.amount);
      if (!delta.isZero()) {
        await tx.budget.update({
          where: { id: reservation.budgetId },
          data: { spent: { increment: delta } },
        });
      }

      return tx.budgetReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.SETTLED, settledAmount: actualAmount },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Releases a reservation — decrements `spent` to return the held amount,
   * then marks the row RELEASED. Idempotent: a row already RELEASED or
   * SETTLED is returned unchanged without touching `spent`.
   */
  async releaseReservation(reservationId: string): Promise<BudgetReservation> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.budgetReservation.findUniqueOrThrow({
        where: { id: reservationId },
      });
      if (
        reservation.status === ReservationStatus.RELEASED ||
        reservation.status === ReservationStatus.SETTLED
      ) {
        return reservation;
      }

      await tx.budget.update({
        where: { id: reservation.budgetId },
        data: { spent: { decrement: reservation.amount } },
      });

      return tx.budgetReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.RELEASED },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  findReservationById(id: string): Promise<BudgetReservation | null> {
    return this.prisma.budgetReservation.findUnique({ where: { id } });
  }
}

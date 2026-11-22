import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BudgetCarryOverRule,
  BudgetPeriod,
  BudgetPeriodStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PrismaTransactionService } from '../../../database/prisma-transaction.service';
import { DEFAULT_BUDGET_ROLLOVER_CONFIG } from '../../../config/budget-rollover.config';
import { DomainEventName } from '../../../events/event-names';
import { BudgetPeriodRepository } from '../budget-period.repository';
import { BudgetRolloverService } from './budget-rollover.service';

const databaseUrl = process.env.DATABASE_URL;
const JAN = new Date('2026-01-01T00:00:00.000Z');
const FEB = new Date('2026-02-01T00:00:00.000Z');
const MAR = new Date('2026-03-01T00:00:00.000Z');
const NOW = new Date('2026-02-15T00:00:00.000Z');
const suffix = randomUUID();
const organizationId = `rollover-org-${suffix}`;
const budgetId = `rollover-budget-${suffix}`;

describe.skipIf(!databaseUrl)('BudgetRolloverService (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: BudgetRolloverService;
  let emit: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl as string } },
    });
    await prisma.$connect();

    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Rollover test org',
        slug: `rollover-test-${suffix}`,
      },
    });
    await prisma.budget.create({
      data: {
        id: budgetId,
        organizationId,
        name: 'Rollover test budget',
        limitAmount: new Prisma.Decimal(100),
        spent: new Prisma.Decimal(40),
        period: BudgetPeriod.MONTHLY,
        periodStart: JAN,
        periodEnd: FEB,
        periodAnchor: JAN,
        periodIndex: 0,
        timezone: 'UTC',
        carryOverRule: BudgetCarryOverRule.UNUSED,
      },
    });

    const transactions = {
      run: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
        prisma.$transaction(fn, { maxWait: 5_000, timeout: 10_000 }),
    } as PrismaTransactionService;
    emit = vi.fn().mockResolvedValue(undefined);

    service = new BudgetRolloverService(
      new BudgetPeriodRepository(prisma as unknown as PrismaService),
      transactions,
      { emit } as never,
      { get: () => DEFAULT_BUDGET_ROLLOVER_CONFIG } as never,
    );
  }, 30_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.budgetPeriodRecord.deleteMany({ where: { organizationId } });
    await prisma.budget.deleteMany({ where: { organizationId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  }, 30_000);

  it('is idempotent when two workers roll the same expired budget concurrently', async () => {
    const results = await Promise.all([
      service.rolloverBudget(budgetId, NOW),
      service.rolloverBudget(budgetId, NOW),
    ]);

    expect(results.filter((result) => result.outcome === 'rolled_over')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'skipped')).toHaveLength(1);

    const updated = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(updated.periodStart.toISOString()).toBe(FEB.toISOString());
    expect(updated.periodEnd?.toISOString()).toBe(MAR.toISOString());
    expect(updated.periodIndex).toBe(1);
    expect(updated.spent.toString()).toBe('60');

    const records = await prisma.budgetPeriodRecord.findMany({
      where: { budgetId },
      orderBy: { periodStart: 'asc' },
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      periodStart: JAN,
      periodEnd: FEB,
      status: BudgetPeriodStatus.CLOSED,
    });
    expect(records[0].finalSpent?.toString()).toBe('40');
    expect(records[1]).toMatchObject({
      periodStart: FEB,
      periodEnd: MAR,
      status: BudgetPeriodStatus.OPEN,
    });
    expect(records[1].openingBalance?.toString()).toBe('60');

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      DomainEventName.BudgetPeriodRollover,
      expect.objectContaining({ budgetId, periodStart: FEB.toISOString() }),
      expect.anything(),
    );
  }, 30_000);

  it('does not open another period on a second run', async () => {
    const result = await service.rolloverBudget(budgetId, NOW);

    expect(result.outcome).toBe('skipped');
    await expect(
      prisma.budgetPeriodRecord.count({ where: { budgetId } }),
    ).resolves.toBe(2);
    expect(emit).toHaveBeenCalledTimes(1);
  }, 30_000);
});

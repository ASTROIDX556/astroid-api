import { describe, expect, it } from 'vitest';
import { BudgetCarryOverRule, BudgetPeriod, Prisma } from '@prisma/client';
import {
  addPeriod,
  computeCarryOver,
  currentPeriodBounds,
  getNthPeriodBounds,
  getPeriodBounds,
  isValidTimezone,
} from './period.util';

const instant = (value: string): Date => new Date(value);
const iso = (value: Date): string => value.toISOString();

describe('budget period boundaries', () => {
  it.each([
    {
      name: 'daily in UTC',
      period: BudgetPeriod.DAILY,
      timezone: 'UTC',
      anchor: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
    },
    {
      name: 'weekly in UTC',
      period: BudgetPeriod.WEEKLY,
      timezone: 'UTC',
      anchor: '2026-01-01T00:00:00.000Z',
      end: '2026-01-08T00:00:00.000Z',
    },
    {
      name: 'monthly in UTC',
      period: BudgetPeriod.MONTHLY,
      timezone: 'UTC',
      anchor: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z',
    },
    {
      name: 'quarterly in UTC',
      period: BudgetPeriod.QUARTERLY,
      timezone: 'UTC',
      anchor: '2026-01-31T00:00:00.000Z',
      end: '2026-04-30T00:00:00.000Z',
    },
    {
      name: 'yearly in UTC',
      period: BudgetPeriod.YEARLY,
      timezone: 'UTC',
      anchor: '2024-02-29T00:00:00.000Z',
      end: '2025-02-28T00:00:00.000Z',
    },
    {
      name: 'month end clamps to 28 days',
      period: BudgetPeriod.MONTHLY,
      timezone: 'UTC',
      anchor: '2026-01-31T00:00:00.000Z',
      end: '2026-02-28T00:00:00.000Z',
    },
    {
      name: 'month end clamps to 29 days in a leap year',
      period: BudgetPeriod.MONTHLY,
      timezone: 'UTC',
      anchor: '2024-01-31T00:00:00.000Z',
      end: '2024-02-29T00:00:00.000Z',
    },
    {
      name: 'monthly keeps local midnight in a fixed-offset timezone',
      period: BudgetPeriod.MONTHLY,
      timezone: 'Africa/Lagos',
      anchor: '2026-01-31T23:00:00.000Z',
      end: '2026-02-28T23:00:00.000Z',
    },
    {
      name: 'daily keeps local midnight across spring-forward DST',
      period: BudgetPeriod.DAILY,
      timezone: 'America/New_York',
      anchor: '2026-03-07T08:00:00.000Z',
      end: '2026-03-08T07:00:00.000Z',
    },
    {
      name: 'daily keeps local midnight across fall-back DST',
      period: BudgetPeriod.DAILY,
      timezone: 'America/New_York',
      anchor: '2026-10-31T07:00:00.000Z',
      end: '2026-11-01T08:00:00.000Z',
    },
    {
      name: 'weekly keeps local midnight across DST',
      period: BudgetPeriod.WEEKLY,
      timezone: 'America/New_York',
      anchor: '2026-03-02T08:00:00.000Z',
      end: '2026-03-09T07:00:00.000Z',
    },
    {
      name: 'monthly keeps local midnight across DST',
      period: BudgetPeriod.MONTHLY,
      timezone: 'America/New_York',
      anchor: '2026-03-01T08:00:00.000Z',
      end: '2026-04-01T07:00:00.000Z',
    },
    {
      name: 'one-time budgets never advance',
      period: BudgetPeriod.ONE_TIME,
      timezone: 'UTC',
      anchor: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T00:00:00.000Z',
    },
  ])('$name', ({ period, timezone, anchor, end }) => {
    expect(iso(getPeriodBounds(period, instant(anchor), timezone).end)).toBe(end);
    expect(iso(addPeriod(instant(anchor), period, timezone))).toBe(end);
  });

  it('anchors month-end clamping so Feb 28 is followed by Mar 31', () => {
    const anchor = instant('2026-01-31T00:00:00.000Z');
    expect(iso(getNthPeriodBounds(BudgetPeriod.MONTHLY, anchor, 'UTC', 1).start)).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(iso(getNthPeriodBounds(BudgetPeriod.MONTHLY, anchor, 'UTC', 2).start)).toBe(
      '2026-03-31T00:00:00.000Z',
    );
  });

  it('keeps the original start and treats the end as exclusive', () => {
    const bounds = getPeriodBounds(BudgetPeriod.DAILY, instant('2026-01-01T00:00:00.000Z'));
    expect(iso(bounds.start)).toBe('2026-01-01T00:00:00.000Z');
    expect(bounds.end.getTime()).toBeGreaterThan(bounds.start.getTime());
  });

  it('skips every elapsed window when a job was down for several periods', () => {
    const bounds = currentPeriodBounds(
      BudgetPeriod.MONTHLY,
      instant('2025-12-31T00:00:00.000Z'),
      'UTC',
      instant('2026-03-15T00:00:00.000Z'),
    );
    expect(iso(bounds.start)).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(bounds.end)).toBe('2026-03-31T00:00:00.000Z');
  });

  it('does not advance to a period that has not elapsed yet', () => {
    const bounds = currentPeriodBounds(
      BudgetPeriod.DAILY,
      instant('2026-01-01T00:00:00.000Z'),
      'UTC',
      instant('2026-01-01T12:00:00.000Z'),
    );
    expect(iso(bounds.start)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('validates IANA timezone names', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('computeCarryOver', () => {
  it.each([
    { rule: BudgetCarryOverRule.NONE, limit: '100', spent: '40', expected: '0' },
    { rule: BudgetCarryOverRule.UNUSED, limit: '100', spent: '40', expected: '60' },
    { rule: BudgetCarryOverRule.UNUSED, limit: '100', spent: '120', expected: '0' },
    { rule: BudgetCarryOverRule.OVERSPEND, limit: '100', spent: '120', expected: '-20' },
    { rule: BudgetCarryOverRule.OVERSPEND, limit: '100', spent: '40', expected: '0' },
    { rule: BudgetCarryOverRule.NET, limit: '100', spent: '40', expected: '60' },
    { rule: BudgetCarryOverRule.NET, limit: '100', spent: '120', expected: '-20' },
  ])('$rule with limit $limit and spend $spent carries $expected', ({ rule, limit, spent, expected }) => {
    expect(computeCarryOver(rule, limit, spent).toFixed(7)).toBe(`${expected}.0000000`.replace('-.', '-'));
  });

  it('keeps seven-decimal precision', () => {
    const result = computeCarryOver(BudgetCarryOverRule.NET, '10.0000001', '9.0000002');
    expect(result.equals(new Prisma.Decimal('0.9999999'))).toBe(true);
  });
});

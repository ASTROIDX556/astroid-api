import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_SPEND_STATUSES,
  startOfDayUtc,
  startOfMonthUtc,
  startOfWeekUtc,
  windowBoundsUtc,
} from './spending-window.util';

/**
 * The window maths must be pure functions of an injected instant, so tests pin
 * `at` to a known UTC moment and assert the exact boundary. None of them read
 * the system clock, so they are deterministic regardless of where they run.
 */
describe('spending-window.util', () => {
  // ── startOfDayUtc ────────────────────────────────────────────────────────

  describe('startOfDayUtc', () => {
    it('returns midnight UTC of the given day', () => {
      expect(startOfDayUtc(new Date('2026-09-30T13:37:42.999Z'))).toEqual(
        new Date('2026-09-30T00:00:00.000Z'),
      );
    });

    it('handles the last day of a month', () => {
      expect(startOfDayUtc(new Date('2026-01-31T23:59:59.999Z'))).toEqual(
        new Date('2026-01-31T00:00:00.000Z'),
      );
    });

    it('defaults to "now" when no instant is supplied', () => {
      const before = new Date();
      const result = startOfDayUtc();
      const after = new Date();
      expect(result.getUTCHours()).toBe(0);
      expect(result.getUTCMinutes()).toBe(0);
      expect(result.getUTCSeconds()).toBe(0);
      // Still the same UTC calendar day as the call instant.
      expect(result.getTime()).toBeGreaterThanOrEqual(startOfDayUtc(before).getTime());
      expect(result.getTime()).toBeLessThanOrEqual(startOfDayUtc(after).getTime());
    });
  });

  // ── startOfWeekUtc (ISO week, Monday) ───────────────────────────────────

  describe('startOfWeekUtc', () => {
    it('returns Monday when the instant is a Monday', () => {
      // 2026-09-28 is a Monday.
      expect(startOfWeekUtc(new Date('2026-09-28T15:00:00.000Z'))).toEqual(
        new Date('2026-09-28T00:00:00.000Z'),
      );
    });

    it('rolls a Sunday back to the previous Monday (ISO week rollover)', () => {
      // 2026-10-04 is a Sunday → Monday is 2026-09-28.
      expect(startOfWeekUtc(new Date('2026-10-04T01:23:45.000Z'))).toEqual(
        new Date('2026-09-28T00:00:00.000Z'),
      );
    });

    it('rolls a Saturday back to the same week Monday', () => {
      // 2026-10-03 is a Saturday → Monday is 2026-09-28.
      expect(startOfWeekUtc(new Date('2026-10-03T23:59:59.999Z'))).toEqual(
        new Date('2026-09-28T00:00:00.000Z'),
      );
    });

    it('crosses a month boundary within a week', () => {
      // 2026-09-01 is a Tuesday → Monday is 2026-08-31 (previous month).
      expect(startOfWeekUtc(new Date('2026-09-01T09:00:00.000Z'))).toEqual(
        new Date('2026-08-31T00:00:00.000Z'),
      );
    });

    it('crosses a year boundary when the week straddles New Year', () => {
      // 2027-01-01 is a Friday → its ISO week starts Monday 2026-12-28.
      expect(startOfWeekUtc(new Date('2027-01-01T00:00:00.000Z'))).toEqual(
        new Date('2026-12-28T00:00:00.000Z'),
      );
    });
  });

  // ── startOfMonthUtc ─────────────────────────────────────────────────────

  describe('startOfMonthUtc', () => {
    it('returns the first of the month at midnight UTC', () => {
      expect(startOfMonthUtc(new Date('2026-09-30T13:37:42.999Z'))).toEqual(
        new Date('2026-09-01T00:00:00.000Z'),
      );
    });

    it('handles a leap day in February', () => {
      // 2028 is a leap year; Feb has 29 days.
      expect(startOfMonthUtc(new Date('2028-02-29T23:59:59.999Z'))).toEqual(
        new Date('2028-02-01T00:00:00.000Z'),
      );
    });

    it('rolls over from December to January of the next year', () => {
      expect(startOfMonthUtc(new Date('2026-12-31T23:59:59.999Z'))).toEqual(
        new Date('2026-12-01T00:00:00.000Z'),
      );
      expect(startOfMonthUtc(new Date('2027-01-01T00:00:00.000Z'))).toEqual(
        new Date('2027-01-01T00:00:00.000Z'),
      );
    });
  });

  // ── windowBoundsUtc ─────────────────────────────────────────────────────

  describe('windowBoundsUtc', () => {
    it('returns all three boundaries for a mid-month mid-week instant', () => {
      // 2026-09-30 is a Wednesday.
      const bounds = windowBoundsUtc(new Date('2026-09-30T12:00:00.000Z'));
      expect(bounds.startOfDay).toEqual(new Date('2026-09-30T00:00:00.000Z'));
      expect(bounds.startOfWeek).toEqual(new Date('2026-09-28T00:00:00.000Z'));
      expect(bounds.startOfMonth).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it('is invariant to the millisecond portion of the instant', () => {
      const base = windowBoundsUtc(new Date('2026-09-30T12:00:00.000Z'));
      const later = windowBoundsUtc(new Date('2026-09-30T23:59:59.999Z'));
      expect(base).toEqual(later);
    });

    it('never uses the local timezone (boundaries are always midnight UTC)', () => {
      const bounds = windowBoundsUtc(new Date('2026-09-30T12:00:00.000Z'));
      for (const bound of [bounds.startOfDay, bounds.startOfWeek, bounds.startOfMonth]) {
        expect(bound.getUTCHours()).toBe(0);
        expect(bound.getUTCMinutes()).toBe(0);
        expect(bound.getUTCSeconds()).toBe(0);
        expect(bound.getUTCMilliseconds()).toBe(0);
      }
    });
  });

  // ── EXCLUDED_SPEND_STATUSES ─────────────────────────────────────────────

  describe('EXCLUDED_SPEND_STATUSES', () => {
    it('excludes only terminal-failed states', () => {
      expect([...EXCLUDED_SPEND_STATUSES].sort()).toEqual(
        ['CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED'].sort(),
      );
    });

    it('does not exclude in-flight or settled states', () => {
      // PENDING must count — the issue requires pending spend to reserve allowance.
      expect(EXCLUDED_SPEND_STATUSES).not.toContain('PENDING');
      expect(EXCLUDED_SPEND_STATUSES).not.toContain('DRAFT');
      expect(EXCLUDED_SPEND_STATUSES).not.toContain('SUBMITTED');
      expect(EXCLUDED_SPEND_STATUSES).not.toContain('CONFIRMED');
      expect(EXCLUDED_SPEND_STATUSES).not.toContain('COMPLETED');
    });
  });
});

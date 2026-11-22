import { TransactionStatus } from '@prisma/client';

/**
 * Rolling time-window budget maths for spending policies.
 *
 * Every window is computed in **UTC** — the server's local timezone is never
 * consulted, so a policy enforced in one region behaves identically in
 * another and the "reset" boundary of a window is the same instant everywhere.
 *
 * Window semantics (documented so callers can rely on them):
 *
 * - **Daily** — the current UTC calendar day: midnight `00:00:00.000Z` today.
 * - **Weekly** — the current ISO week: the most recent Monday at midnight UTC.
 * - **Monthly** — the current calendar month: `00:00:00.000Z` on the 1st.
 *
 * These are *calendar* windows (they reset at a fixed boundary), which is what
 * the `dailyLimit` / `weeklyLimit` / `monthlyLimit` policy fields describe. A
 * trailing rolling window (e.g. "the last N minutes") is not modelled here
 * because the policy schema does not carry an amount-based rolling-minutes
 * limit; the schema's `velocity` field is a transaction *count*, not an amount.
 *
 * Spend aggregation counts every transaction that has left the wallet or is in
 * flight, and excludes only terminal-failed states (the funds never left, or
 * were returned). Counting in-flight spend (DRAFT/PENDING/APPROVED/SUBMITTED)
 * is deliberate: an agent must not be able to bypass a window by racing several
 * transactions through before any of them settle. The same statuses are used
 * by {@link SpendingLimitService.aggregateSpend} and by the spending-allowance
 * read endpoint so the "used" figure the client sees matches what is enforced.
 */
export const EXCLUDED_SPEND_STATUSES: readonly TransactionStatus[] = [
  TransactionStatus.FAILED,
  TransactionStatus.CANCELLED,
  TransactionStatus.REJECTED,
  TransactionStatus.EXPIRED,
];

/** The three calendar windows a spending policy can cap. */
export interface SpendingWindowBounds {
  /** Inclusive lower bound of the current UTC calendar day. */
  startOfDay: Date;
  /** Inclusive lower bound of the current ISO week (Monday, UTC). */
  startOfWeek: Date;
  /** Inclusive lower bound of the current UTC calendar month. */
  startOfMonth: Date;
}

/** Start of the UTC calendar day containing `at` (inclusive). */
export function startOfDayUtc(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Start of the ISO week (Monday) containing `at`, in UTC (inclusive). */
export function startOfWeekUtc(at: Date = new Date()): Date {
  // getUTCDay(): 0 = Sunday … 6 = Saturday. ISO weeks start on Monday, so the
  // offset to the most recent Monday is (day + 6) % 7 (Sun → 6, Mon → 0, …).
  const daysSinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - daysSinceMonday),
  );
}

/** Start of the UTC calendar month containing `at` (inclusive). */
export function startOfMonthUtc(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * Returns the inclusive lower bound of all three standard windows for `at`.
 * Aggregation queries use these as `createdAt: { gte: <bound> }`.
 */
export function windowBoundsUtc(at: Date = new Date()): SpendingWindowBounds {
  const startOfDay = startOfDayUtc(at);
  const startOfWeek = startOfWeekUtc(at);
  const startOfMonth = startOfMonthUtc(at);
  return { startOfDay, startOfWeek, startOfMonth };
}

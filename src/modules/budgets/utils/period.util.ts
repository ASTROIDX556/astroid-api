import { BudgetCarryOverRule, BudgetPeriod, Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;

/** Inclusive start / exclusive end of one fixed budget period. */
export interface PeriodBounds {
  start: Date;
  end: Date;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      era: 'short',
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

/** True when the runtime recognises the string as an IANA timezone. */
export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Rejects invalid timezones before they reach stored budget configuration. */
export function assertTimezone(timezone: string): string {
  if (!isValidTimezone(timezone)) {
    throw new RangeError(`Unknown IANA timezone: ${timezone}`);
  }
  return timezone;
}

function zonedParts(instant: Date, timezone: string): ZonedParts {
  const values: Record<string, number> = {};
  let era = 'AD';
  for (const part of formatter(timezone).formatToParts(instant)) {
    if (part.type === 'literal') continue;
    if (part.type === 'era') {
      era = part.value;
    } else {
      values[part.type] = Number(part.value);
    }
  }
  const year = values.year;
  return {
    year: era === 'BC' ? 1 - year : year,
    month: values.month,
    day: values.day,
    hour: values.hour % 24,
    minute: values.minute,
    second: values.second,
    millisecond: instant.getUTCMilliseconds(),
  };
}

function utcFromParts(parts: ZonedParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

/** Milliseconds by which local wall-clock time leads UTC at a given instant. */
function timezoneOffsetMs(instant: Date, timezone: string): number {
  const local = zonedParts(instant, timezone);
  return utcFromParts(local) - instant.getTime();
}

function sameParts(left: ZonedParts, right: ZonedParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * Converts a wall-clock date in `timezone` to an instant. The two probes around
 * the intended instant disambiguate DST fall-back (two instants share one local
 * time); the earlier valid one is chosen. For a spring-forward time that does
 * not exist, the earliest candidate is the stable interpretation.
 */
function zonedTimeToUtc(parts: ZonedParts, timezone: string): Date {
  const wallClock = utcFromParts(parts);
  const twelveHours = 12 * 3_600_000;
  const candidates = [wallClock - twelveHours, wallClock + twelveHours].map((probe) => {
    const offset = timezoneOffsetMs(new Date(probe), timezone);
    const refined = wallClock - timezoneOffsetMs(new Date(wallClock - offset), timezone);
    return wallClock - timezoneOffsetMs(new Date(refined), timezone);
  });
  const valid = candidates.filter((candidate) =>
    sameParts(zonedParts(new Date(candidate), timezone), parts),
  );
  return new Date(Math.min(...(valid.length > 0 ? valid : candidates)));
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function addLocalMonths(parts: ZonedParts, months: number): ZonedParts {
  const absoluteMonth = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  return {
    ...parts,
    year,
    month,
    // Jan 31 + 1 month is Feb 28 (Feb 29 in a leap year), never Mar 2/3.
    day: Math.min(parts.day, daysInMonth(year, month)),
  };
}

function addLocalDays(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCDate(date.getUTCDate() + days);
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * Advances an instant by whole periods while preserving the wall-clock time in
 * `timezone`. Date arithmetic is done on local components, so a DST shift changes
 * the UTC duration of the period (23h/25h days) but never moves the local boundary.
 */
export function addPeriod(date: Date, period: BudgetPeriod, timezone = 'UTC'): Date {
  assertTimezone(timezone);
  if (period === BudgetPeriod.ONE_TIME) return new Date(date.getTime());

  const parts = zonedParts(date, timezone);
  let target: ZonedParts;
  switch (period) {
    case BudgetPeriod.DAILY:
      target = addLocalDays(parts, 1);
      break;
    case BudgetPeriod.WEEKLY:
      target = addLocalDays(parts, 7);
      break;
    case BudgetPeriod.MONTHLY:
      target = addLocalMonths(parts, 1);
      break;
    case BudgetPeriod.QUARTERLY:
      target = addLocalMonths(parts, 3);
      break;
    case BudgetPeriod.YEARLY:
      target = addLocalMonths(parts, 12);
      break;
    default:
      return new Date(date.getTime());
  }
  return zonedTimeToUtc(target, timezone);
}

/** Start/end of the period that begins at `anchor`. */
export function getPeriodBounds(
  period: BudgetPeriod,
  anchor: Date,
  timezone = 'UTC',
): PeriodBounds {
  const start = new Date(anchor.getTime());
  return { start, end: addPeriod(start, period, timezone) };
}

/**
 * Start of the `index`-th period after the original anchor. Arithmetic always
 * starts from the anchor, so a Jan 31 budget whose February window ends on Feb
 * 28 opens March on Mar 31 rather than drifting to Mar 28.
 */
export function nthPeriodStart(
  period: BudgetPeriod,
  anchor: Date,
  timezone: string,
  index: number,
): Date {
  if (index <= 0 || period === BudgetPeriod.ONE_TIME) return new Date(anchor.getTime());
  const parts = zonedParts(anchor, timezone);
  let target: ZonedParts;
  switch (period) {
    case BudgetPeriod.DAILY:
      target = addLocalDays(parts, index);
      break;
    case BudgetPeriod.WEEKLY:
      target = addLocalDays(parts, index * 7);
      break;
    case BudgetPeriod.MONTHLY:
      target = addLocalMonths(parts, index);
      break;
    case BudgetPeriod.QUARTERLY:
      target = addLocalMonths(parts, index * 3);
      break;
    case BudgetPeriod.YEARLY:
      target = addLocalMonths(parts, index * 12);
      break;
    default:
      return new Date(anchor.getTime());
  }
  return zonedTimeToUtc(target, timezone);
}

/** Bounds of the period with the given index after `anchor`. */
export function getNthPeriodBounds(
  period: BudgetPeriod,
  anchor: Date,
  timezone: string,
  index: number,
): PeriodBounds {
  return {
    start: nthPeriodStart(period, anchor, timezone, index),
    end: nthPeriodStart(period, anchor, timezone, index + 1),
  };
}

/**
 * Advances a possibly stale anchor to the current period. Used when a job was
 * down across several boundaries: every elapsed window is still closed exactly
 * once by the rollover service. The guard prevents a corrupt anchor (or an
 * unreasonable period) from looping forever.
 */
export function currentPeriodBounds(
  period: BudgetPeriod,
  anchor: Date,
  timezone: string,
  now: Date,
): PeriodBounds {
  let index = 0;
  let bounds = getNthPeriodBounds(period, anchor, timezone, index);
  for (let guard = 0; guard < 10_000 && bounds.end.getTime() <= now.getTime(); guard += 1) {
    index += 1;
    bounds = getNthPeriodBounds(period, anchor, timezone, index);
  }
  return bounds;
}

/**
 * Carry-over amount for a closed period, as a 7-decimal Decimal.
 *
 * - NONE: zero (the safe default; a period always starts from zero).
 * - UNUSED: positive remainder only, capped at the limit.
 * - OVERSPEND: negative balance only, so overspend stays visible.
 * - NET: both directions (limit - spend), which may be negative.
 */
export function computeCarryOver(
  rule: BudgetCarryOverRule,
  limit: Prisma.Decimal.Value,
  spent: Prisma.Decimal.Value,
): Prisma.Decimal {
  const remainder = new Decimal(limit).minus(new Decimal(spent));
  let amount: Prisma.Decimal;
  switch (rule) {
    case BudgetCarryOverRule.UNUSED:
      amount = remainder.isNegative() ? new Decimal(0) : remainder;
      break;
    case BudgetCarryOverRule.OVERSPEND:
      amount = remainder.isNegative() ? remainder : new Decimal(0);
      break;
    case BudgetCarryOverRule.NET:
      amount = remainder;
      break;
    case BudgetCarryOverRule.NONE:
    default:
      amount = new Decimal(0);
  }
  return amount.toDecimalPlaces(7, Prisma.Decimal.ROUND_HALF_UP);
}

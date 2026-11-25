/**
 * Atomic per-credential quota check, executed as one Redis round trip so every
 * API replica observes the same counters and two concurrent requests can never
 * both consume the last slot.
 *
 * Two fixed windows are enforced together: a short (per-minute) window and a
 * long (per-day) window. A request is counted only when it fits in **both**;
 * rejected requests consume nothing, so a client that keeps retrying while
 * limited regains capacity as soon as the exhausted window rolls over.
 *
 * The clock is read with `TIME` inside the script rather than passed in from
 * the caller, so app-server clock skew cannot shift a window, and windows are
 * aligned to absolute epoch multiples (`floor(now / window) * window`) so every
 * replica agrees on the current bucket without any coordination. Expiry uses
 * `PEXPIREAT` with the absolute window end, which stays correct for very long
 * windows and survives a Redis restart (the counter and its deadline are both
 * persisted).
 *
 * KEYS[1] = minute counter key prefix
 * KEYS[2] = day counter key prefix
 * ARGV[1] = minute limit
 * ARGV[2] = minute window (ms)
 * ARGV[3] = day limit
 * ARGV[4] = day window (ms)
 * returns { allowed (0|1), limit, remaining, resetAt (epoch ms),
 *           retryAfter (ms), minuteHits, dayHits }
 */
export const CREDENTIAL_RATE_LIMIT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local minuteLimit = tonumber(ARGV[1])
local minuteWindow = tonumber(ARGV[2])
local dayLimit = tonumber(ARGV[3])
local dayWindow = tonumber(ARGV[4])

local minuteStart = math.floor(now / minuteWindow) * minuteWindow
local dayStart = math.floor(now / dayWindow) * dayWindow
local minuteKey = KEYS[1] .. ':' .. minuteStart
local dayKey = KEYS[2] .. ':' .. dayStart
local minuteReset = minuteStart + minuteWindow
local dayReset = dayStart + dayWindow

local minuteHits = tonumber(redis.call('GET', minuteKey) or '0')
local dayHits = tonumber(redis.call('GET', dayKey) or '0')

local allowed = 1
if minuteHits >= minuteLimit or dayHits >= dayLimit then
  allowed = 0
end

if allowed == 1 then
  minuteHits = tonumber(redis.call('INCR', minuteKey))
  if minuteHits == 1 then
    redis.call('PEXPIREAT', minuteKey, minuteReset)
  end
  dayHits = tonumber(redis.call('INCR', dayKey))
  if dayHits == 1 then
    redis.call('PEXPIREAT', dayKey, dayReset)
  end
end

local minuteRemaining = minuteLimit - minuteHits
if minuteRemaining < 0 then
  minuteRemaining = 0
end
local dayRemaining = dayLimit - dayHits
if dayRemaining < 0 then
  dayRemaining = 0
end

-- The reported quota is the window closest to exhaustion, measured as the
-- fraction of its budget still available.
local limit = minuteLimit
local remaining = minuteRemaining
local resetAt = minuteReset
if (dayRemaining / dayLimit) < (minuteRemaining / minuteLimit) then
  limit = dayLimit
  remaining = dayRemaining
  resetAt = dayReset
end

-- A blocked request may only succeed once every exhausted window has rolled
-- over, so the retry delay is the latest of those resets.
local retryAfter = 0
if allowed == 0 then
  if minuteHits >= minuteLimit then
    retryAfter = minuteReset - now
  end
  if dayHits >= dayLimit and (dayReset - now) > retryAfter then
    retryAfter = dayReset - now
  end
  if retryAfter < 0 then
    retryAfter = 0
  end
end

return {allowed, limit, remaining, resetAt, retryAfter, minuteHits, dayHits}
`;

/** Flat numeric result returned by {@link CREDENTIAL_RATE_LIMIT_SCRIPT}. */
export type CredentialRateLimitScriptResult = [
  allowed: number,
  limit: number,
  remaining: number,
  resetAt: number,
  retryAfter: number,
  minuteHits: number,
  dayHits: number,
];

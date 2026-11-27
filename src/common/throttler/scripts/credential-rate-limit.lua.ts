/**
 * Atomic per-credential quota check, executed as one Redis round trip so every
 * API replica observes the same counters and two concurrent requests can never
 * both consume the last slot.
 *
 * Two sliding windows are enforced together: a short (per-minute) window and a
 * long (per-day) window. A request is counted only when it fits in **both**;
 * rejected requests consume nothing, so capacity returns as old requests leave
 * the trailing windows.
 *
 * The clock is read with `TIME` inside the script rather than passed in from
 * the caller, so app-server clock skew cannot shift a window. An optional
 * timestamp is accepted only to make tests deterministic. Redis sorted sets
 * retain the timestamps of accepted requests and expire after each window.
 *
 * KEYS[1] = minute-window sorted set
 * KEYS[2] = day-window sorted set
 * ARGV[1] = minute limit
 * ARGV[2] = minute window (ms)
 * ARGV[3] = day limit
 * ARGV[4] = day window (ms)
 * ARGV[5] = unique request id
 * ARGV[6] = optional test clock (epoch ms; 0 uses Redis TIME)
 * returns { allowed (0|1), limit, remaining, resetAt (epoch ms),
 *           retryAfter (ms), minuteHits, dayHits }
 */
export const CREDENTIAL_RATE_LIMIT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local testNow = tonumber(ARGV[6])
if testNow and testNow > 0 then
  now = testNow
end

local minuteLimit = tonumber(ARGV[1])
local minuteWindow = tonumber(ARGV[2])
local dayLimit = tonumber(ARGV[3])
local dayWindow = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - minuteWindow)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - dayWindow)

local minuteHits = redis.call('ZCARD', KEYS[1])
local dayHits = redis.call('ZCARD', KEYS[2])

local allowed = 1
if minuteHits >= minuteLimit or dayHits >= dayLimit then
  allowed = 0
end

if allowed == 1 then
  redis.call('ZADD', KEYS[1], now, ARGV[5])
  redis.call('ZADD', KEYS[2], now, ARGV[5])
  redis.call('PEXPIRE', KEYS[1], minuteWindow)
  redis.call('PEXPIRE', KEYS[2], dayWindow)
  minuteHits = minuteHits + 1
  dayHits = dayHits + 1
end

local minuteRemaining = minuteLimit - minuteHits
if minuteRemaining < 0 then
  minuteRemaining = 0
end
local dayRemaining = dayLimit - dayHits
if dayRemaining < 0 then
  dayRemaining = 0
end

local minuteReset = now + minuteWindow
local minuteOldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if minuteOldest[2] then
  minuteReset = tonumber(minuteOldest[2]) + minuteWindow
end

local dayReset = now + dayWindow
local dayOldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
if dayOldest[2] then
  dayReset = tonumber(dayOldest[2]) + dayWindow
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

-- A blocked request may only succeed once each exhausted window has freed a
-- slot, so the retry delay is the latest next expiration among those windows.
local retryAfter = 0
if allowed == 0 then
  if minuteHits >= minuteLimit then
    retryAfter = math.max(0, minuteReset - now)
  end
  if dayHits >= dayLimit then
    retryAfter = math.max(retryAfter, dayReset - now)
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

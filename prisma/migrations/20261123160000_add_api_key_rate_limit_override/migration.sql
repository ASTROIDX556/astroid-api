-- Optional per-key override of the rate limit (requests per window).
-- NULL keeps the existing behaviour: the key's scope tier and the globally
-- configured budget govern its traffic.
ALTER TABLE "api_keys" ADD COLUMN "rateLimitPerMinute" INTEGER;

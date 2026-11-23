-- A webhook delivery that exhausted its retry budget, or was permanently
-- rejected by the consumer, is parked in DEAD_LETTER so it can be listed and
-- manually replayed instead of being retried forever.
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';

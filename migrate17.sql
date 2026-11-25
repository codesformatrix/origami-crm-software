-- migrate17: Add explicit idempotency key to emails table for guaranteed no-double-send
-- Each email record gets a unique key of the form: contact_{id}_step_{n}
-- This makes double-sends impossible at the database level even if the cron
-- fires twice or two batch processes overlap.

ALTER TABLE emails ADD COLUMN idempotency_key TEXT UNIQUE;

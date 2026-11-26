-- Location/timezone columns for an older Origami CRM database.
-- Run once against an existing D1. If a column already exists, skip that
-- statement and continue; a fresh database should use schema.sql instead.
ALTER TABLE companies ADD COLUMN city TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN country TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN country_key TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN country_code TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN timezone TEXT DEFAULT '';

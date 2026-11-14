-- Research/enrichment columns for spreadsheet imports.
-- Run against an existing D1 database. Skip any statement whose column already exists.
ALTER TABLE companies ADD COLUMN funding_stage TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN total_raised TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN last_funding_date TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN open_eng_roles TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN recent_news TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN public_appearances TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN criteria_flags TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN time_in_role TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN previous_roles TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN education TEXT DEFAULT '';

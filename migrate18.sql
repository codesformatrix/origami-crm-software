-- migrate18: Add hook_used and sources columns to email_drafts
-- The Ali writer persona returns hook_used (the specific detail/angle used)
-- and sources (URLs cited) in its JSON response. Persisting these gives
-- auditability and helps the scorer verify the hook is grounded in research.

ALTER TABLE email_drafts ADD COLUMN hook_used TEXT NOT NULL DEFAULT '';
ALTER TABLE email_drafts ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';

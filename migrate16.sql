-- migrate16.sql — Gmail SMTP (App Password) connection support
-- Adds SMTP credential columns to gmail_connections for bypassing OAuth consent.
ALTER TABLE gmail_connections ADD COLUMN smtp_email TEXT NOT NULL DEFAULT '';
ALTER TABLE gmail_connections ADD COLUMN smtp_password_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE gmail_connections ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'oauth';

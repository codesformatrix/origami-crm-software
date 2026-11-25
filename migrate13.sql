-- Compliance, deliverability and privacy controls (migration 13)
CREATE TABLE IF NOT EXISTS suppressed_email_hashes (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'unsubscribe',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('daily_send_cap','25'),
  ('domain_start',''),
  ('master_send_paused','0'),
  ('sending_domain',''),
  ('dkim_selector','google'),
  ('deliverability_wizard_complete','0'),
  ('legitimate_interest_note','B2B prospect data is used only to identify relevant business contacts, conduct tailored business-to-business outreach, and manage follow-ups. We document a legitimate-interest assessment, minimize data, honor objections immediately, and erase data on request. Do not store sensitive personal data.'),
  ('free_gmail_warning_acknowledged','0');

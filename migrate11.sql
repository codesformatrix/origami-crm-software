-- Business-day Gmail cadence, sequence linkage, pause reasons, and bounce suppression.
ALTER TABLE enrollments ADD COLUMN stop_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE emails ADD COLUMN sequence_id INTEGER;
ALTER TABLE emails ADD COLUMN enrollment_id INTEGER;
ALTER TABLE copywriting_jobs ADD COLUMN sequence_id INTEGER;
ALTER TABLE copywriting_jobs ADD COLUMN enrollment_id INTEGER;
CREATE TABLE IF NOT EXISTS bounce_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  email_id INTEGER NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  gmail_message_id TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bounce_events_domain ON bounce_events(domain,detected_at);
CREATE TABLE IF NOT EXISTS domain_suppressions (
  domain TEXT PRIMARY KEY,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('gmail_step2_business_days','3'),
  ('gmail_step3_business_days','4'),
  ('gmail_step4_business_days','5');

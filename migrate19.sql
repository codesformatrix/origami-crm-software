-- migrate19: Step-level logging table + review mode setting
-- Every pipeline step (queued, researching, drafted, scheduled, sent,
-- failed, skipped) gets a row here with error text for auditability.
-- Never fail silently: every transition is recorded.

CREATE TABLE IF NOT EXISTS step_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  step_number INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  component TEXT NOT NULL DEFAULT 'pipeline',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_step_logs_contact ON step_logs(contact_id, step_number, created_at);
CREATE INDEX IF NOT EXISTS idx_step_logs_status ON step_logs(status, created_at);

-- Default settings for the new switches
INSERT OR IGNORE INTO settings(key,value) VALUES('review_mode','off');
INSERT OR IGNORE INTO settings(key,value) VALUES('global_pause','off');

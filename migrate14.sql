CREATE TABLE IF NOT EXISTS timezone_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  detail TEXT DEFAULT '',
  error TEXT DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_timezone_jobs_status ON timezone_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_timezone_jobs_contact ON timezone_jobs(contact_id);

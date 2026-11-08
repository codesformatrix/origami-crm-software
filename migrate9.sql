-- AI copywriting queue and unsent draft records. Sent mail remains in messages.
CREATE TABLE IF NOT EXISTS copywriting_jobs (
  contact_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  unsubscribe_url TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_copywriting_jobs_status ON copywriting_jobs(status,queued_at);

CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  step_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  unsubscribe_url TEXT NOT NULL DEFAULT '',
  personalization_score INTEGER,
  score_breakdown TEXT NOT NULL DEFAULT '{}',
  score_critique TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  constraints_valid INTEGER NOT NULL DEFAULT 0,
  is_user_edited INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  scheduled_at TEXT,
  sent_message_id INTEGER,
  UNIQUE(contact_id,step_number),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_drafts_contact_step ON email_drafts(contact_id,step_number);
CREATE INDEX IF NOT EXISTS idx_email_drafts_status ON email_drafts(status,scheduled_at);

ALTER TABLE messages ADD COLUMN email_draft_id INTEGER;

INSERT OR IGNORE INTO settings(key,value) VALUES ('copywriting_hourly_cap','10');

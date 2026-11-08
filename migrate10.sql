-- Gmail OAuth, scheduled delivery, audit attempts, per-prospect timezone and safety cap.
ALTER TABLE contacts ADD COLUMN timezone TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO settings(key,value) VALUES ('daily_send_cap','25');

CREATE TABLE IF NOT EXISTS gmail_connections (
  id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL DEFAULT 'disconnected',
  email_address TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '',
  access_token_enc TEXT NOT NULL DEFAULT '', refresh_token_enc TEXT NOT NULL DEFAULT '',
  access_expires_at TEXT, history_id TEXT NOT NULL DEFAULT '', connected_at TEXT,
  last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state_hash TEXT PRIMARY KEY, verifier_enc TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email_draft_id INTEGER NOT NULL UNIQUE, contact_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', scheduled_at TEXT NOT NULL, next_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0, gmail_message_id TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '',
  rfc_message_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(email_draft_id) REFERENCES email_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_emails_queue ON emails(status,scheduled_at,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_emails_contact ON emails(contact_id,status);
CREATE TABLE IF NOT EXISTS email_send_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER NOT NULL, attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL, http_status INTEGER, error TEXT NOT NULL DEFAULT '', retry_at TEXT,
  attempted_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_attempts_email ON email_send_attempts(email_id,attempt_number);
CREATE TABLE IF NOT EXISTS gmail_send_state (
  id INTEGER PRIMARY KEY CHECK(id=1), lock_owner TEXT NOT NULL DEFAULT '', lock_until TEXT, last_sent_at TEXT
);
INSERT OR IGNORE INTO gmail_send_state(id) VALUES(1);

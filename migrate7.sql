-- Phase 0 foundation: research records, classified replies, and sender safeguards.
-- Apply once to an existing D1 database after backup. Fresh databases use schema.sql.
CREATE TABLE IF NOT EXISTS research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'website',
  source_url TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  pain_points TEXT NOT NULL DEFAULT '[]',
  talking_points TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_research_notes_contact ON research_notes(contact_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER,
  prospect_id INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  classification TEXT NOT NULL DEFAULT 'neutral',
  raw_text TEXT DEFAULT '',
  FOREIGN KEY (email_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (prospect_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replies_contact_received ON replies(prospect_id, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_message_unique ON replies(email_id) WHERE email_id IS NOT NULL;

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('sender_name',''),
  ('sender_company','Origami Consulting'),
  ('physical_mailing_address',''),
  ('sending_window_start_hour','9'),
  ('sending_window_end_hour','17');

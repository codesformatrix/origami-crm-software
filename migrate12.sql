-- Gmail thread-aware reply detection, editable suggested replies, and permanent email suppression.
ALTER TABLE messages ADD COLUMN gmail_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
ALTER TABLE replies ADD COLUMN gmail_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE replies ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
ALTER TABLE replies ADD COLUMN suggested_reply TEXT NOT NULL DEFAULT '';
ALTER TABLE replies ADD COLUMN return_date TEXT NOT NULL DEFAULT '';
ALTER TABLE replies ADD COLUMN classification_error TEXT NOT NULL DEFAULT '';
ALTER TABLE replies ADD COLUMN handled_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_gmail_message_id ON messages(gmail_message_id) WHERE gmail_message_id<>'';
CREATE INDEX IF NOT EXISTS idx_replies_thread_received ON replies(thread_id,received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_gmail_message_unique ON replies(gmail_message_id) WHERE gmail_message_id<>'';
CREATE TABLE IF NOT EXISTS suppressed_emails (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppressed_emails_reason ON suppressed_emails(reason,created_at);

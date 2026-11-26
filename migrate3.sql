-- Tracking, settings and snippets added in the current build.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER, company_id INTEGER,
  type TEXT NOT NULL, url TEXT DEFAULT '', detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE,
  contact_id INTEGER, kind TEXT NOT NULL DEFAULT 'click', target TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('default_cadence','4'),('user_tz',''),('daily_cap','30'),('domain_start','');
CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  shortcut TEXT DEFAULT '', body TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (date('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_contact ON events(contact_id, created_at);

-- Sequences, tasks, tags and activity tables added after the first CRM build.
CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 1,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT DEFAULT '', body TEXT DEFAULT '',
  wait_days INTEGER NOT NULL DEFAULT 4,
  condition TEXT NOT NULL DEFAULT 'always',
  variant TEXT NOT NULL DEFAULT 'A', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL, sequence_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  next_step_at TEXT, variant TEXT NOT NULL DEFAULT 'A',
  started_at TEXT NOT NULL DEFAULT (date('now')), finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  contact_id INTEGER, company_id INTEGER, due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT 'slate'
);
CREATE TABLE IF NOT EXISTS contact_tags (contact_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(contact_id, tag_id));
CREATE TABLE IF NOT EXISTS company_tags (company_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(company_id, tag_id));
CREATE INDEX IF NOT EXISTS idx_enrollments_contact_status ON enrollments(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_done_due ON tasks(done, due_date);

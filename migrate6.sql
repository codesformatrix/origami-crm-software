-- User-managed outreach projects with reusable title/location matching rules.
-- Apply once to an existing D1 database; schema.sql includes these tables for new installs.
CREATE TABLE IF NOT EXISTS outreach_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  title_terms TEXT DEFAULT '',
  location_terms TEXT DEFAULT '',
  match_mode TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, contact_id),
  FOREIGN KEY (project_id) REFERENCES outreach_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_members_contact ON project_members(contact_id);

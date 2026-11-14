-- Origami Outreach CRM — fresh D1 schema
-- Cloudflare D1 is SQLite, so this file also works with Wrangler's local D1.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT DEFAULT '',
  website TEXT DEFAULT '',
  linkedin TEXT DEFAULT '',
  sub_niche TEXT DEFAULT '',
  what_they_do TEXT DEFAULT '',
  employees TEXT DEFAULT '',
  hq TEXT DEFAULT '',
  founded TEXT DEFAULT '',
  funding TEXT DEFAULT '',
  funding_stage TEXT DEFAULT '',
  total_raised TEXT DEFAULT '',
  last_funding_date TEXT DEFAULT '',
  open_eng_roles TEXT DEFAULT '',
  recent_news TEXT DEFAULT '',
  public_appearances TEXT DEFAULT '',
  criteria_flags TEXT DEFAULT '',
  context TEXT DEFAULT '',
  risks TEXT DEFAULT '',
  live_product TEXT DEFAULT '',
  founders TEXT DEFAULT '',
  technical_lead TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT DEFAULT 'manual',
  cadence INTEGER NOT NULL DEFAULT 4,
  created_at TEXT NOT NULL DEFAULT (date('now')),
  city TEXT DEFAULT '',
  country TEXT DEFAULT '',
  country_key TEXT DEFAULT '',
  country_code TEXT DEFAULT '',
  timezone TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT DEFAULT '',
  title TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  linkedin TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  time_in_role TEXT DEFAULT '',
  previous_roles TEXT DEFAULT '',
  education TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  cadence INTEGER NOT NULL DEFAULT 4,
  touch_count INTEGER NOT NULL DEFAULT 0,
  last_touch TEXT,
  next_action TEXT,
  created_at TEXT NOT NULL DEFAULT (date('now')),
  email_discovery_status TEXT NOT NULL DEFAULT 'not_requested',
  timezone TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status_next ON contacts(status, next_action);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  direction TEXT NOT NULL DEFAULT 'out',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  template_id INTEGER,
  email_draft_id INTEGER,
  gmail_message_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_direction_date ON messages(direction, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_gmail_message_id ON messages(gmail_message_id) WHERE gmail_message_id<>'';

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT ''
);

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
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  wait_days INTEGER NOT NULL DEFAULT 4,
  condition TEXT NOT NULL DEFAULT 'always',
  variant TEXT NOT NULL DEFAULT 'A',
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence ON sequence_steps(sequence_id, step_order);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  sequence_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  next_step_at TEXT,
  variant TEXT NOT NULL DEFAULT 'A',
  started_at TEXT NOT NULL DEFAULT (date('now')),
  finished_at TEXT,
  stop_reason TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_enrollments_contact_status ON enrollments(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_next ON enrollments(status, next_step_at);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  contact_id INTEGER,
  company_id INTEGER,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (date('now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_done_due ON tasks(done, due_date);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT 'slate'
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (contact_id, tag_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS company_tags (
  company_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (company_id, tag_id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER,
  company_id INTEGER,
  type TEXT NOT NULL,
  url TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_contact ON events(contact_id, created_at);

CREATE TABLE IF NOT EXISTS tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  contact_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'click',
  target TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Store permanent opt-out suppressions as irreversible digests, not raw addresses.
CREATE TABLE IF NOT EXISTS suppressed_email_hashes (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'unsubscribe',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('default_cadence', '4'),
  ('user_tz', ''),
  ('daily_cap', '30'),
  ('daily_send_cap', '25'),
  ('domain_start', ''),
  ('master_send_paused', '0'),
  ('sending_domain', ''),
  ('dkim_selector', 'google'),
  ('deliverability_wizard_complete', '0'),
  ('legitimate_interest_note', 'B2B prospect data is used only to identify relevant business contacts, conduct tailored business-to-business outreach, and manage follow-ups. We document a legitimate-interest assessment, minimize data, honor objections immediately, and erase data on request. Do not store sensitive personal data.'),
  ('free_gmail_warning_acknowledged', '0');

CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  shortcut TEXT DEFAULT '',
  body TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (date('now'))
);


-- Meter optional, user-initiated AI drafts by UTC day.
CREATE TABLE IF NOT EXISTS ai_usage (
  usage_date TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);

-- Custom, user-managed outreach projects. Matching projects auto-categorize
-- prospects on spreadsheet import; manual/excluded membership preserves user control.
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

-- Phase 0: prospect research history and classified replies.
CREATE TABLE IF NOT EXISTS research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'website',
  source_url TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  pain_points TEXT NOT NULL DEFAULT '[]',
  talking_points TEXT NOT NULL DEFAULT '[]',
  icp_score INTEGER,
  icp_reason TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_research_notes_contact ON research_notes(contact_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS copywriting_jobs (
  contact_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', unsubscribe_url TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sequence_id INTEGER, enrollment_id INTEGER,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_copywriting_jobs_status ON copywriting_jobs(status,queued_at);
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
  updated_at TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_timezone_jobs_status ON timezone_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_timezone_jobs_contact ON timezone_jobs(contact_id);
CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, step_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', unsubscribe_url TEXT NOT NULL DEFAULT '',
  personalization_score INTEGER, score_breakdown TEXT NOT NULL DEFAULT '{}', score_critique TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0, constraints_valid INTEGER NOT NULL DEFAULT 0, is_user_edited INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')), edited_at TEXT, scheduled_at TEXT, sent_message_id INTEGER,
  UNIQUE(contact_id,step_number), FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_drafts_contact_step ON email_drafts(contact_id,step_number);
CREATE INDEX IF NOT EXISTS idx_email_drafts_status ON email_drafts(status,scheduled_at);


-- Gmail OAuth tokens are AES-GCM encrypted with a server-side key. Never return
-- token columns from API routes. One single-user connection is supported.
CREATE TABLE IF NOT EXISTS gmail_connections (
  id INTEGER PRIMARY KEY CHECK(id=1),
  status TEXT NOT NULL DEFAULT 'disconnected',
  email_address TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  access_token_enc TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT NOT NULL DEFAULT '',
  access_expires_at TEXT,
  history_id TEXT NOT NULL DEFAULT '',
  connected_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_draft_id INTEGER NOT NULL UNIQUE,
  contact_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_at TEXT NOT NULL,
  next_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  gmail_message_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  rfc_message_id TEXT NOT NULL DEFAULT '',
  sequence_id INTEGER,
  enrollment_id INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(email_draft_id) REFERENCES email_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_emails_queue ON emails(status,scheduled_at,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_emails_contact ON emails(contact_id,status);
CREATE TABLE IF NOT EXISTS email_send_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error TEXT NOT NULL DEFAULT '',
  retry_at TEXT,
  attempted_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_attempts_email ON email_send_attempts(email_id,attempt_number);
CREATE TABLE IF NOT EXISTS gmail_send_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  lock_owner TEXT NOT NULL DEFAULT '',
  lock_until TEXT,
  last_sent_at TEXT
);
INSERT OR IGNORE INTO gmail_send_state(id) VALUES(1);

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

CREATE TABLE IF NOT EXISTS enrichment_jobs (
  contact_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0, queued_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT,
  finished_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status, queued_at);
CREATE TABLE IF NOT EXISTS provider_usage (
  provider TEXT NOT NULL, window_type TEXT NOT NULL, window_key TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(provider, window_type, window_key)
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER,
  prospect_id INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  classification TEXT NOT NULL DEFAULT 'neutral',
  raw_text TEXT DEFAULT '',
  gmail_message_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  suggested_reply TEXT NOT NULL DEFAULT '',
  return_date TEXT NOT NULL DEFAULT '',
  classification_error TEXT NOT NULL DEFAULT '',
  handled_at TEXT,
  FOREIGN KEY (email_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (prospect_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replies_contact_received ON replies(prospect_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_replies_thread_received ON replies(thread_id,received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_message_unique ON replies(email_id) WHERE email_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_gmail_message_unique ON replies(gmail_message_id) WHERE gmail_message_id<>'';

-- Permanent email-level suppression survives contact deletion and backup restores.
CREATE TABLE IF NOT EXISTS suppressed_emails (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppressed_emails_reason ON suppressed_emails(reason,created_at);

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('sender_name',''),
  ('sender_company','Origami Consulting'),
  ('physical_mailing_address',''),
  ('sending_window_start_hour','9'),
  ('sending_window_end_hour','17'),
  ('apollo_daily_cap','2'),('apollo_monthly_cap','25'),('hunter_daily_cap','1'),('hunter_monthly_cap','25'),
  ('firecrawl_daily_cap','30'),('firecrawl_monthly_cap','500'),('tavily_daily_cap','50'),('tavily_monthly_cap','500'),
  ('serper_daily_cap','100'),('serper_lifetime_cap','2500'),('groq_daily_cap','50'),('gemini_daily_cap','10'),
  ('openrouter_daily_cap','20'),('copywriting_hourly_cap','10'),('daily_send_cap','25'),('gmail_step2_business_days','3'),('gmail_step3_business_days','4'),('gmail_step4_business_days','5'),('icp_authority','Founder, CEO, CTO, VP/Director of Engineering or Product, or another budget-owning decision maker'),
  ('icp_company_size_min','10'),('icp_company_size_max','500'),
  ('icp_technology_fit','Technology and services fit: software/product engineering, modernization, cloud, AI/data, or delivery capacity needs that Origami Consulting can address');

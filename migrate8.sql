-- Phase 1: prospect enrichment, public research, ICP settings and provider quota ledger.
ALTER TABLE contacts ADD COLUMN email_discovery_status TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE research_notes ADD COLUMN icp_score INTEGER;
ALTER TABLE research_notes ADD COLUMN icp_reason TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS enrichment_jobs (
  contact_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status, queued_at);

CREATE TABLE IF NOT EXISTS provider_usage (
  provider TEXT NOT NULL,
  window_type TEXT NOT NULL,
  window_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(provider, window_type, window_key)
);

INSERT OR IGNORE INTO settings(key,value) VALUES
 ('apollo_daily_cap','2'),('apollo_monthly_cap','25'),
 ('hunter_daily_cap','1'),('hunter_monthly_cap','25'),
 ('firecrawl_daily_cap','30'),('firecrawl_monthly_cap','500'),
 ('tavily_daily_cap','50'),('tavily_monthly_cap','500'),
 ('serper_daily_cap','100'),('serper_lifetime_cap','2500'),
 ('groq_daily_cap','50'),('gemini_daily_cap','10'),('openrouter_daily_cap','20'),
 ('icp_authority','Founder, CEO, CTO, VP/Director of Engineering or Product, or another budget-owning decision maker'),
 ('icp_company_size_min','10'),('icp_company_size_max','500'),
 ('icp_technology_fit','Technology and services fit: software/product engineering, modernization, cloud, AI/data, or delivery capacity needs that Origami Consulting can address');

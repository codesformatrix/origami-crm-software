-- migrate20: Evidence provenance + LLM usage ledger
--
-- 1. llm_usage_log: per-provider and per-prospect LLM attempt metrics.
--    Every attempt recorded by functions/lib/usage.js (recordLlmUsage)
--    writes one row: which prospect triggered it, which provider/model,
--    which operation (orchestrator_generate, copywriting_generate,
--    copywriting_score, enrichment_synthesis, timezone_infer, ...),
--    the outcome and latency.
-- 2. research_reuse_hours: default reuse window for scheduled-email
--    refreshes. When recent VERIFIED research (search_api,
--    website_scrape, user_provided) exists within this window, the
--    refresh reuses it instead of searching again. Set to 0 to always
--    re-search on refresh.
--
-- research_notes.source_type needs no schema change: the new evidence
-- types (search_api, website_scrape, user_provided, llm_inference) are
-- values enforced by functions/lib/evidence.js, not new columns.

CREATE TABLE IF NOT EXISTS llm_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'unknown',
  model TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL DEFAULT 'llm',
  status TEXT NOT NULL DEFAULT 'unknown',
  error TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_contact ON llm_usage_log(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON llm_usage_log(provider, created_at);

INSERT OR IGNORE INTO settings(key,value) VALUES('research_reuse_hours','48');

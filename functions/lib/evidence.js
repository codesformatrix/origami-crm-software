// Evidence provenance for research notes.
//
// Every piece of prospect research is labelled with exactly one evidence
// type. Downstream email generation must never treat llm_inference as
// verified evidence: only search_api, website_scrape and user_provided
// count as verified.

export const EVIDENCE = {
  SEARCH_API: 'search_api',
  WEBSITE_SCRAPE: 'website_scrape',
  USER_PROVIDED: 'user_provided',
  LLM_INFERENCE: 'llm_inference',
};

// Evidence types that may be cited as fact in generated emails.
export const VERIFIED_EVIDENCE = [
  EVIDENCE.SEARCH_API,
  EVIDENCE.WEBSITE_SCRAPE,
  EVIDENCE.USER_PROVIDED,
];

export function isVerifiedEvidence(type) {
  return VERIFIED_EVIDENCE.includes(String(type || ''));
}

/**
 * Map a raw source label (as returned by search/scrape helpers) to an
 * evidence type. Unknown labels are treated as unverified llm_inference so
 * provenance never silently upgrades guesswork to verified evidence.
 */
export function mapSourceApiToEvidence(sourceApi) {
  const s = String(sourceApi || '').toLowerCase().trim();
  if (s === 'tavily' || s === 'serper' || s === 'search') return EVIDENCE.SEARCH_API;
  if (s === 'firecrawl' || s === 'website' || s === 'scrape') return EVIDENCE.WEBSITE_SCRAPE;
  if (s === 'user' || s === 'user_provided' || s === 'upload' || s === 'import') return EVIDENCE.USER_PROVIDED;
  if (s === 'llm' || s === 'llm_inference' || s === 'inference') return EVIDENCE.LLM_INFERENCE;
  return EVIDENCE.LLM_INFERENCE;
}

/**
 * Rank two evidence types by trust: verified types outrank llm_inference.
 * Used when a note synthesises mixed sources and needs a single label.
 */
const TRUST_RANK = {
  [EVIDENCE.SEARCH_API]: 3,
  [EVIDENCE.WEBSITE_SCRAPE]: 2,
  [EVIDENCE.USER_PROVIDED]: 1,
  [EVIDENCE.LLM_INFERENCE]: 0,
};

export function strongestEvidence(...types) {
  let best = EVIDENCE.LLM_INFERENCE;
  for (const t of types) {
    const v = String(t || '');
    if (!v) continue;
    if (!Object.prototype.hasOwnProperty.call(TRUST_RANK, v)) continue;
    if (TRUST_RANK[v] > TRUST_RANK[best]) best = v;
  }
  return best;
}

/**
 * Prompt-facing label for an evidence type. Used to instruct the writer
 * whether research may be cited as fact.
 */
export function evidenceLabel(type) {
  if (type === EVIDENCE.LLM_INFERENCE) return 'unverified AI recollection (llm_inference)';
  if (type === EVIDENCE.SEARCH_API) return 'verified search results (search_api)';
  if (type === EVIDENCE.WEBSITE_SCRAPE) return 'verified website content (website_scrape)';
  if (type === EVIDENCE.USER_PROVIDED) return 'user-provided data (user_provided)';
  return 'unknown provenance';
}

/**
 * Rules text injected into writer prompts. Keeps unsupported claims out of
 * generated emails: company events, prospect activity and business news may
 * only be stated as fact when backed by verified evidence.
 */
export const EVIDENCE_DISCIPLINE_RULE = [
  'Evidence discipline:',
  '- Each research item carries an "evidence" label. "search_api", "website_scrape" and "user_provided" are verified and may be stated as fact.',
  '- "llm_inference" items are unverified AI recollection. Never present company events, business news, funding, hiring, or prospect activity from an llm_inference item as fact.',
  '- If you use an llm_inference item, hedge explicitly (for example "I believe I saw… worth confirming") or omit it. Prefer verified items for the hook.',
  '- Never invent events, dates, or news that no research item supports.',
].join(' ');

/**
 * Parse a research_notes.fetched_at value (SQLite datetime('now') format or
 * ISO) to epoch milliseconds. Returns 0 when unparseable so callers can
 * treat unknown ages as "stale" rather than "fresh".
 */
export function parseFetchedAt(value) {
  if (!value) return 0;
  const raw = String(value).trim();
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.getTime();
  // SQLite default: "YYYY-MM-DD HH:MM:SS" (UTC).
  const normalized = raw.replace(' ', 'T') + (raw.includes('T') ? '' : 'Z');
  const fallback = new Date(normalized);
  return Number.isNaN(fallback.getTime()) ? 0 : fallback.getTime();
}

/**
 * Load recent research notes for a contact that carry verified evidence.
 * Used by scheduled-email refreshes to reuse existing research instead of
 * searching again. Returns rows ordered newest-first, filtered to verified
 * evidence types within maxAgeHours.
 */
export async function loadRecentVerifiedNotes(DB, contactId, maxAgeHours = 48, now = Date.now()) {
  const cutoff = now - Math.max(0, Number(maxAgeHours) || 0) * 3600 * 1000;
  const rows = (await DB.prepare(
    `SELECT * FROM research_notes WHERE contact_id=? AND source_type IN (?,?,?)
     ORDER BY fetched_at DESC, id DESC`
  ).bind(contactId, EVIDENCE.SEARCH_API, EVIDENCE.WEBSITE_SCRAPE, EVIDENCE.USER_PROVIDED).all()).results || [];
  return rows.filter((r) => parseFetchedAt(r.fetched_at) >= cutoff);
}

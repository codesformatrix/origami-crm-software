// Per-provider and per-prospect LLM usage metrics.
//
// Two concerns:
// 1. Provider cooldowns: after a provider returns 429/402/403/5xx, it is
//    marked in cooldown so later generation calls in the same pipeline tick
//    skip it instead of burning subrequests on a known-bad provider.
// 2. Usage ledger: every LLM attempt is recorded with the prospect it was
//    made for, the provider/model, operation and outcome.

const nowIso = () => new Date().toISOString();

const COOLDOWN_WINDOW = 'cooldown';
const COOLDOWN_KEY = 'active';

/**
 * Normalize a contact id for the usage ledger.
 *
 * llm_usage_log.contact_id is nullable and references contacts(id) ON DELETE
 * SET NULL, so a usage record must never carry a non-existent id. Missing,
 * zero, negative, or non-integer values collapse to NULL (a global/system
 * record); valid positive integers are preserved.
 */
const normalizeContactId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * DB-backed provider cooldown store compatible with the cooldown hook
 * consumed by llm.js generateWithFallback({ cooldown }).
 *
 * Cooldowns are stored as rows in provider_usage:
 *   provider   = 'llm_cooldown:<name>'
 *   window_type = 'cooldown'
 *   window_key  = 'active'
 *   used        = epoch milliseconds until which the provider is cooling down
 *
 * Reusing provider_usage keeps the schema unchanged; cooldown rows never
 * collide with quota rows because the provider key is prefixed.
 */
export function llmCooldownStore(DB) {
  return {
    async isCoolingDown(name) {
      const row = await DB.prepare(
        "SELECT used FROM provider_usage WHERE provider=? AND window_type=? AND window_key=?"
      ).bind(`llm_cooldown:${name}`, COOLDOWN_WINDOW, COOLDOWN_KEY).first();
      return Number(row?.used || 0) > Date.now();
    },
    async markCooldown(name, ttlMs, reason = '') {
      const until = Date.now() + Math.max(0, Number(ttlMs) || 0);
      await DB.prepare(
        `INSERT INTO provider_usage(provider,window_type,window_key,used,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(provider,window_type,window_key)
         DO UPDATE SET used=excluded.used, updated_at=excluded.updated_at`
      ).bind(`llm_cooldown:${name}`, COOLDOWN_WINDOW, COOLDOWN_KEY, until, nowIso()).run();
      if (reason) {
        await DB.prepare(
          "INSERT OR REPLACE INTO settings(key,value) VALUES('last_llm_cooldown',?)"
        ).bind(`${name}: ${String(reason).slice(0, 200)}`).run();
      }
    },
    async clearCooldown(name) {
      await DB.prepare(
        "DELETE FROM provider_usage WHERE provider=? AND window_type=? AND window_key=?"
      ).bind(`llm_cooldown:${name}`, COOLDOWN_WINDOW, COOLDOWN_KEY).run();
    },
  };
}

/**
 * Record one LLM attempt for a prospect. Never throws — metrics must not
 * break the generation pipeline (mirrors logStep's fail-safe contract).
 *
 * Expected record: { contactId, provider, model, operation, status, error, latencyMs }
 *
 * A missing, zero, or invalid contactId is stored as NULL (the column is
 * nullable, FK ... ON DELETE SET NULL), so usage records for prospects that
 * have no valid contact id still persist instead of failing the FK and being
 * silently dropped.
 */
export async function recordLlmUsage(DB, record) {
  try {
    await DB.prepare(
      `INSERT INTO llm_usage_log(contact_id,provider,model,operation,status,error,latency_ms,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).bind(
      normalizeContactId(record.contactId),
      String(record.provider || 'unknown').slice(0, 60),
      String(record.model || '').slice(0, 120),
      String(record.operation || 'llm').slice(0, 60),
      String(record.status || 'unknown').slice(0, 40),
      String(record.error || '').slice(0, 500),
      Math.max(0, Math.round(Number(record.latencyMs) || 0)),
      nowIso()
    ).run();
  } catch {
    // Metrics are best-effort.
  }
}

/**
 * Build an onAttempt callback for generateWithFallback that records every
 * attempt against the given prospect and operation.
 */
export function llmAttemptRecorder(DB, { contactId, operation }) {
  return async (attempt) => {
    await recordLlmUsage(DB, { contactId, operation, ...attempt });
  };
}

/**
 * Summarize recorded LLM usage. Optional contactId narrows to one prospect.
 * Returns per-provider totals plus the raw rows (for diagnostics UIs).
 */
export async function llmUsageSummary(DB, contactId = null) {
  if (contactId) {
    const rows = (await DB.prepare(
      `SELECT provider,model,operation,status,COUNT(*) AS calls
       FROM llm_usage_log WHERE contact_id=? GROUP BY provider,model,operation,status
       ORDER BY calls DESC, provider`
    ).bind(Number(contactId) || 0).all()).results || [];
    return { scope: 'prospect', contact_id: Number(contactId) || 0, totals: rows };
  }
  const rows = (await DB.prepare(
    `SELECT provider,model,operation,status,COUNT(*) AS calls
     FROM llm_usage_log GROUP BY provider,model,operation,status
     ORDER BY calls DESC, provider`
  ).all()).results || [];
  return { scope: 'all', totals: rows };
}

// PR #1 production-blocker verification tests.
// Covers: (1) DB-backed cooldown persistence across separate invocations,
// (2) unverified LLM research cannot enter verified evidence paths,
// (4) usage logging failures cannot break generation.
// Migration-20 schema verification lives in tools/migrate20_verify_test.mjs.
//
// Run: node tools/pr_review_test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { generateWithFallback, resetProviderCooldowns } from '../functions/lib/llm.js';
import { EVIDENCE } from '../functions/lib/evidence.js';
import { llmCooldownStore } from '../functions/lib/usage.js';
import { gatherFreshContext } from '../functions/lib/copywriting.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e?.message || e}`);
  }
}

const FAST = { retryBaseMs: 1, retryCapMs: 4 };

function makeDB() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() {
          const r = raw.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid || 0) } };
        },
        async first() { return raw.prepare(sql).get(...args) || null; },
        async all() { return { results: raw.prepare(sql).all(...args) }; },
      };
    },
    close() { raw.close(); },
  };
}

function fakeResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/* ------------------------------------------- (1) cooldown persistence */

console.log('\n== (1) DB-backed cooldown persistence across invocations ==');

await test('cooldown set in invocation 1 is honored by invocation 2 via a fresh store', async () => {
  resetProviderCooldowns();
  const db = makeDB();
  const env = { GROQ_API_KEY: 'test-key-placeholder', GEMINI_API_KEY: 'test-key-placeholder' };
  const groqCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.groq.com')) {
      groqCalls.push(String(url));
      return fakeResponse(429, 'rate limited', { 'retry-after': '0' });
    }
    return fakeResponse(200, { candidates: [{ content: { parts: [{ text: 'via gemini' }] } }] });
  };
  try {
    // Invocation 1: fresh store instance, groq 429s twice (attempt + bounded
    // retry) and gets cooled down; gemini succeeds.
    const store1 = llmCooldownStore(db);
    const r1 = await generateWithFallback(env, [{ role: 'user', content: 'hi' }], { ...FAST, cooldown: store1 });
    assert.equal(r1.provider, 'gemini');
    assert.equal(groqCalls.length, 2, 'invocation 1: groq initial attempt + one bounded retry');

    // Invocation 2: a brand-new store instance (new Cloudflare invocation
    // would have empty in-memory state) bound to the SAME D1 database.
    const store2 = llmCooldownStore(db);
    groqCalls.length = 0;
    const r2 = await generateWithFallback(env, [{ role: 'user', content: 'hi' }], { ...FAST, cooldown: store2 });
    assert.equal(r2.provider, 'gemini');
    assert.equal(groqCalls.length, 0, 'invocation 2: cooled-down groq must not be called');

    // The cooldown row survived in D1 and expires in the future.
    const row = await db.prepare("SELECT used FROM provider_usage WHERE provider='llm_cooldown:groq' AND window_type='cooldown' AND window_key='active'").first();
    assert.ok(row, 'cooldown persisted in provider_usage');
    assert.ok(Number(row.used) > Date.now(), 'cooldown expiry stored as future epoch ms');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

await test('successful call clears the DB cooldown after it expires', async () => {
  resetProviderCooldowns();
  const db = makeDB();
  const store1 = llmCooldownStore(db);
  // Mark a short cooldown, then let it expire naturally (simulates the
  // cooldown window passing between cron ticks).
  await store1.markCooldown('groq', 5, 'HTTP 429');
  assert.equal(await store1.isCoolingDown('groq'), true);
  await new Promise((r) => setTimeout(r, 25));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse(200, { choices: [{ message: { content: 'ok' } }] });
  try {
    const store2 = llmCooldownStore(db); // fresh invocation, same D1
    const r = await generateWithFallback({ GROQ_API_KEY: 'test-key-placeholder' }, [{ role: 'user', content: 'hi' }], { cooldown: store2, ...FAST });
    assert.equal(r.provider, 'groq');
    const row = await db.prepare("SELECT COUNT(*) AS n FROM provider_usage WHERE provider='llm_cooldown:groq'").first();
    assert.equal(Number(row?.n || 0), 0, 'successful call cleared the cooldown row');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

/* ------------------------------ (2) unverified research isolation */

console.log('\n== (2) unverified LLM research cannot enter verified evidence paths ==');

async function seedProspect(db, noteSourceType = null) {
  const co = await db.prepare("INSERT INTO companies(name,domain,website,employees,what_they_do,sub_niche,timezone,created_at) VALUES('Northstar Software','northstar.example','https://northstar.example','80','Analytics software','B2B analytics','America/New_York',date('now'))").run();
  const ct = await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,cadence,created_at) VALUES(?,'Riley Example','CTO','riley@northstar.example','new',4,date('now'))").bind(co.meta.last_row_id).run();
  const contactId = ct.meta.last_row_id;
  if (noteSourceType) {
    await db.prepare("INSERT INTO research_notes(contact_id,source_type,source_url,summary,pain_points,talking_points,fetched_at) VALUES(?,?,'','summary text','[]','[]',?)")
      .bind(contactId, noteSourceType, new Date().toISOString()).run();
  }
  return contactId;
}

await test('AI-search fresh context is labelled llm_inference and marked unverified', async () => {
  const db = makeDB();
  // Only an llm_inference note exists — must not be reused as verified research.
  const contactId = await seedProspect(db, EVIDENCE.LLM_INFERENCE);
  const fetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return fakeResponse(200, { choices: [{ message: { content: JSON.stringify({ summary: 'AI search says the company launched something.', facts: [] }) } }] });
  };
  try {
    const data = await gatherFreshContext({ DB: db, GROQ_API_KEY: 'test-key-placeholder' }, db, contactId, 'https://crm.example/u/token');
    assert.equal(data.searchResults.evidence, EVIDENCE.LLM_INFERENCE, 'AI search output labelled llm_inference');
    assert.equal(data.freshContextEvidence, EVIDENCE.LLM_INFERENCE);
    assert.match(data.freshContext, /\[llm_inference — unverified AI search output\]/, 'fresh context carries an inline unverified label');
    assert.equal(data.context.research.fresh_context_evidence, EVIDENCE.LLM_INFERENCE);
    assert.equal(data.context.research.evidence_verified, false, 'llm_inference note is not verified');
    assert.match(data.context.rules.evidence_discipline, /llm_inference/, 'writer prompt carries evidence discipline');
    assert.ok(fetches.length > 0, 'aiWebSearch was used because no verified research existed');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

await test('recent verified research is reused with a verified evidence label and no search', async () => {
  const db = makeDB();
  const contactId = await seedProspect(db, EVIDENCE.SEARCH_API);
  const fetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { fetches.push(String(url)); throw new Error('search must not run when verified research is reused'); };
  try {
    const data = await gatherFreshContext({ DB: db, GROQ_API_KEY: 'test-key-placeholder' }, db, contactId, 'https://crm.example/u/token');
    assert.equal(fetches.length, 0, 'no LLM search when verified research is fresh');
    assert.equal(data.searchResults.evidence, EVIDENCE.SEARCH_API);
    assert.equal(data.freshContextEvidence, EVIDENCE.SEARCH_API);
    assert.match(data.freshContext, /\[search_api\]/, 'reused content carries its verified label');
    assert.match(data.context.rules.fresh_context, /evidence type/i, 'fresh_context rule enforces the label');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

await test('stale verified research is not reused (falls back to labelled AI search)', async () => {
  const db = makeDB();
  const contactId = await seedProspect(db, EVIDENCE.SEARCH_API);
  // Backdate the note beyond the 48h reuse window.
  db.prepare("UPDATE research_notes SET fetched_at=? WHERE contact_id=?").bind(new Date(Date.now() - 200 * 3600 * 1000).toISOString(), contactId).run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse(200, { choices: [{ message: { content: JSON.stringify({ summary: 'late info', facts: [] }) } }] });
  try {
    const data = await gatherFreshContext({ DB: db, GROQ_API_KEY: 'test-key-placeholder' }, db, contactId, 'https://crm.example/u/token');
    assert.equal(data.freshContextEvidence, EVIDENCE.LLM_INFERENCE, 'stale research does not block the labelled AI-search fallback');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

/* ----------------------------- (4) usage logging failure isolation */

console.log('\n== (4) usage logging failures cannot break generation ==');

await test('throwing onAttempt recorder does not break generation', async () => {
  resetProviderCooldowns();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse(200, { choices: [{ message: { content: 'ok' } }] });
  try {
    const result = await generateWithFallback(
      { GROQ_API_KEY: 'test-key-placeholder' },
      [{ role: 'user', content: 'hi' }],
      { onAttempt: async () => { throw new Error('metrics store exploded'); } }
    );
    assert.equal(result.text, 'ok', 'generation succeeds despite recorder failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('recordLlmUsage against a broken DB never throws', async () => {
  const { recordLlmUsage } = await import('../functions/lib/usage.js');
  const broken = { prepare: () => { throw new Error('db down'); } };
  await recordLlmUsage(broken, { contactId: 1, provider: 'groq', model: 'm', operation: 'op', status: '200' });
  const broken2 = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('insert failed'); } }) }) };
  await recordLlmUsage(broken2, { contactId: 1, provider: 'groq' });
});

/* ------------------------------------------------------------ summary */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

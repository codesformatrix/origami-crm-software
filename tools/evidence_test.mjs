// Evidence & reliability patch tests.
// Focused unit tests for: evidence provenance mapping, saveResearchSources
// labeling, LLM diagnostics sanitization, bounded retry + provider cooldown,
// research reuse filtering, and the usage ledger. No network, no DB server.
//
// Run: node tools/evidence_test.mjs

import assert from 'node:assert/strict';

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

const { EVIDENCE, mapSourceApiToEvidence, isVerifiedEvidence, strongestEvidence, parseFetchedAt, loadRecentVerifiedNotes } =
  await import('../functions/lib/evidence.js');
const { sanitizeDiagnostics, rateLimitHeaderSummary, describeHttpError, resetProviderCooldowns } =
  await import('../functions/lib/llm.js');
const { generateWithFallback } = await import('../functions/lib/llm.js');
const { saveResearchSources } = await import('../functions/lib/orchestrator.js');
const { recordLlmUsage, llmCooldownStore } = await import('../functions/lib/usage.js');

/* ------------------------------------------------------------ mocks */

// Mock D1: records SQL statements and returns queued results per table.
function mockDb(behavior = {}) {
  const calls = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      run: async () => { calls.push({ sql, args, kind: 'run' }); return { meta: { changes: behavior.changes ?? 1 } }; },
      get: async () => { calls.push({ sql, args, kind: 'get' }); return behavior.first ?? null; },
      first: async () => { calls.push({ sql, args, kind: 'first' }); return behavior.first ?? null; },
      all: async () => {
        calls.push({ sql, args, kind: 'all' });
        let rows = behavior.rows ?? [];
        // Mimic the IN filter for evidence queries so tests exercise the SQL.
        if (/source_type IN/.test(sql) && args.length > 1) {
          const allowed = args.slice(1);
          rows = rows.filter((r) => allowed.includes(r.source_type));
        }
        return { results: rows };
      },
    }),
  });
  return { prepare, calls };
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

const FAST = { retryBaseMs: 1, retryCapMs: 4 }; // deterministic, near-instant backoff

/* ------------------------------------------------------- evidence types */

console.log('\n== evidence type mapping ==');

await test('mapSourceApiToEvidence maps real sources to verified types', () => {
  assert.equal(mapSourceApiToEvidence('tavily'), EVIDENCE.SEARCH_API);
  assert.equal(mapSourceApiToEvidence('serper'), EVIDENCE.SEARCH_API);
  assert.equal(mapSourceApiToEvidence('firecrawl'), EVIDENCE.WEBSITE_SCRAPE);
  assert.equal(mapSourceApiToEvidence('user_provided'), EVIDENCE.USER_PROVIDED);
});

await test('mapSourceApiToEvidence maps llm fallback and unknowns to llm_inference', () => {
  assert.equal(mapSourceApiToEvidence('llm'), EVIDENCE.LLM_INFERENCE);
  assert.equal(mapSourceApiToEvidence('research_synthesis'), EVIDENCE.LLM_INFERENCE);
  assert.equal(mapSourceApiToEvidence(''), EVIDENCE.LLM_INFERENCE);
  assert.equal(mapSourceApiToEvidence(undefined), EVIDENCE.LLM_INFERENCE);
});

await test('isVerifiedEvidence excludes llm_inference', () => {
  assert.equal(isVerifiedEvidence(EVIDENCE.SEARCH_API), true);
  assert.equal(isVerifiedEvidence(EVIDENCE.WEBSITE_SCRAPE), true);
  assert.equal(isVerifiedEvidence(EVIDENCE.USER_PROVIDED), true);
  assert.equal(isVerifiedEvidence(EVIDENCE.LLM_INFERENCE), false);
  assert.equal(isVerifiedEvidence('nonsense'), false);
});

await test('strongestEvidence ranks verified over inference', () => {
  assert.equal(strongestEvidence(EVIDENCE.LLM_INFERENCE, EVIDENCE.SEARCH_API), EVIDENCE.SEARCH_API);
  assert.equal(strongestEvidence(EVIDENCE.LLM_INFERENCE), EVIDENCE.LLM_INFERENCE);
  assert.equal(strongestEvidence(EVIDENCE.WEBSITE_SCRAPE, EVIDENCE.USER_PROVIDED), EVIDENCE.WEBSITE_SCRAPE);
});

await test('parseFetchedAt handles ISO and SQLite datetime formats', () => {
  const iso = parseFetchedAt('2026-11-26T10:00:00.000Z');
  const sqlite = parseFetchedAt('2026-11-26 10:00:00');
  assert.equal(iso, sqlite);
  assert.equal(parseFetchedAt(''), 0);
  assert.equal(parseFetchedAt('garbage'), 0);
});

/* ----------------------------------------------- saveResearchSources */

console.log('\n== saveResearchSources provenance ==');

await test('saveResearchSources labels LLM fallback as llm_inference with unverified marker', async () => {
  const db = mockDb();
  const research = {
    source_api: 'llm',
    sources: [{ url: 'https://example.com/a', title: 'Made up fact' }],
    facts: ['The company launched a product in March.'],
  };
  await saveResearchSources(db, 7, research);
  const insert = db.calls.find((c) => c.sql.includes('INSERT INTO research_notes'));
  assert.ok(insert, 'research_notes insert was issued');
  assert.equal(insert.args[1], EVIDENCE.LLM_INFERENCE, 'source_type must be llm_inference');
  assert.match(insert.args[3], /UNVERIFIED/, 'summary must carry the unverified marker');
});

await test('saveResearchSources keeps search_api provenance and adds no marker', async () => {
  const db = mockDb();
  const research = {
    source_api: 'tavily',
    sources: [{ url: 'https://news.example.com/b', title: 'Real funding round' }],
    facts: ['The company raised a round.'],
  };
  await saveResearchSources(db, 7, research);
  const insert = db.calls.find((c) => c.sql.includes('INSERT INTO research_notes'));
  assert.equal(insert.args[1], EVIDENCE.SEARCH_API);
  assert.doesNotMatch(insert.args[3], /UNVERIFIED/);
});

await test('saveResearchSources is a no-op without sources', async () => {
  const db = mockDb();
  await saveResearchSources(db, 7, { source_api: 'tavily', sources: [], facts: [] });
  assert.equal(db.calls.filter((c) => c.sql.includes('INSERT')).length, 0);
});

/* ----------------------------------------------------- LLM diagnostics */

console.log('\n== LLM error diagnostics ==');

await test('sanitizeDiagnostics redacts credential-shaped strings and truncates', () => {
  const out = sanitizeDiagnostics('key "sk-abcdef1234567890" exceeded limit x'.repeat(50));
  assert.doesNotMatch(out, /sk-abcdef1234567890/, 'key material must be redacted');
  assert.match(out, /<redacted>/);
  assert.ok(out.length <= 300, 'must be truncated to 300 chars');
  assert.doesNotMatch(out, /\n/, 'whitespace collapsed');
});

await test('rateLimitHeaderSummary captures retry-after and ratelimit headers', () => {
  const h = new Headers({ 'retry-after': '15', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '100', 'content-type': 'application/json' });
  const summary = rateLimitHeaderSummary(h);
  assert.match(summary, /retry-after=15/);
  assert.match(summary, /x-ratelimit-remaining=0/);
  assert.doesNotMatch(summary, /content-type/);
});

await test('describeHttpError includes status, headers and sanitized body', () => {
  const line = describeHttpError('groq', 'openai/gpt-oss-20b', 429, 'rate limited sk-secret123456', new Headers({ 'retry-after': '30' }));
  assert.match(line, /groq \(openai\/gpt-oss-20b\): HTTP 429/);
  assert.match(line, /retry-after=30/);
  assert.doesNotMatch(line, /sk-secret123456/);
});

/* ---------------------------------------- bounded retry + cooldown */

console.log('\n== bounded retry and provider cooldown ==');

await test('429 with Retry-After is retried once, then succeeds', async () => {
  resetProviderCooldowns();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls++;
    if (calls === 1) return fakeResponse(429, 'rate limited', { 'retry-after': '1' });
    return fakeResponse(200, { choices: [{ message: { content: 'hello' } }] });
  };
  try {
    const attempts = [];
    const result = await generateWithFallback(
      { GROQ_API_KEY: 'test-key-placeholder' },
      [{ role: 'user', content: 'hi' }],
      { ...FAST, onAttempt: (a) => attempts.push(a) }
    );
    assert.equal(result.text, 'hello');
    assert.equal(calls, 2, 'exactly one bounded retry');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].ok, false);
    assert.equal(attempts[1].ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('persistent 429 cools the provider down and falls through to the next provider', async () => {
  resetProviderCooldowns();
  const originalFetch = globalThis.fetch;
  const callsByUrl = new Map();
  globalThis.fetch = async (url) => {
    callsByUrl.set(url, (callsByUrl.get(url) || 0) + 1);
    return fakeResponse(429, 'too many requests', { 'retry-after': '1' });
  };
  try {
    const env = { GROQ_API_KEY: 'test-key-placeholder', GEMINI_API_KEY: 'test-key-placeholder' };
    await assert.rejects(
      generateWithFallback(env, [{ role: 'user', content: 'hi' }], { ...FAST }),
      (e) => {
        assert.equal(e.code, 'ALL_PROVIDERS_FAILED');
        assert.match(e.message, /HTTP 429/, 'failure message must include the status');
        assert.match(e.message, /too many requests/, 'failure message must include the sanitized body');
        return true;
      }
    );
    // First call: groq tried twice (1 + bounded retry), gemini tried twice.
    assert.equal(callsByUrl.get('https://api.groq.com/openai/v1/chat/completions'), 2);
    assert.equal(callsByUrl.get('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'), 2);

    // Second call: both providers are in cooldown — no fetches at all.
    callsByUrl.clear();
    await assert.rejects(
      generateWithFallback(env, [{ role: 'user', content: 'hi' }], { ...FAST }),
      (e) => {
        assert.match(e.message, /provider in cooldown/);
        return true;
      }
    );
    assert.equal(callsByUrl.size, 0, 'cooled-down providers must not be called');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('402 marks a long cooldown and the error includes sanitized details', async () => {
  resetProviderCooldowns();
  const originalFetch = globalThis.fetch;
  const db = mockDb();
  globalThis.fetch = async () => fakeResponse(402, 'quota exhausted for api key sk-abcdef0123456789');
  try {
    const store = llmCooldownStore(db);
    await assert.rejects(
      generateWithFallback({ APINEX_API_KEY: 'test-key-placeholder' }, [{ role: 'user', content: 'hi' }], { cooldown: store, ...FAST }),
      (e) => {
        assert.match(e.message, /HTTP 402/);
        assert.match(e.message, /quota exhausted/);
        assert.doesNotMatch(e.message, /sk-abcdef0123456789/, 'key-shaped body text must be redacted');
        return true;
      }
    );
    const mark = db.calls.find((c) => c.sql.includes('INSERT INTO provider_usage'));
    assert.ok(mark, 'cooldown must be persisted via the store');
    assert.match(mark.args[0], /^llm_cooldown:/);
    // APInex model list is tried once (402 is provider-level, no retry).
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ------------------------------------------------------ research reuse */

console.log('\n== research reuse filtering ==');

await test('loadRecentVerifiedNotes keeps only verified evidence within the window', async () => {
  const now = Date.now();
  const rows = [
    { source_type: 'search_api', summary: 'fresh search', fetched_at: new Date(now - 3600 * 1000).toISOString() },
    { source_type: 'website_scrape', summary: 'fresh scrape', fetched_at: new Date(now - 6 * 3600 * 1000).toISOString() },
    { source_type: 'user_provided', summary: 'fresh user data', fetched_at: new Date(now - 10 * 3600 * 1000).toISOString() },
    { source_type: 'llm_inference', summary: 'llm guess', fetched_at: new Date(now - 3600 * 1000).toISOString() },
    { source_type: 'search_api', summary: 'stale search', fetched_at: new Date(now - 120 * 3600 * 1000).toISOString() },
  ];
  const db = mockDb({ rows });
  const out = await loadRecentVerifiedNotes(db, 3, 48);
  assert.equal(out.length, 3, 'verified notes within 48h only');
  assert.ok(out.every((r) => r.source_type !== EVIDENCE.LLM_INFERENCE));
  assert.ok(!out.some((r) => r.summary === 'stale search'));
  const sql = db.calls[0].sql;
  assert.match(sql, /source_type IN/);
});

await test('loadRecentVerifiedNotes returns nothing when nothing is fresh enough', async () => {
  const now = Date.now();
  const rows = [{ source_type: 'search_api', summary: 'old', fetched_at: new Date(now - 200 * 3600 * 1000).toISOString() }];
  const db = mockDb({ rows });
  const out = await loadRecentVerifiedNotes(db, 3, 48);
  assert.equal(out.length, 0);
});

/* ---------------------------------------------------- usage ledger */

console.log('\n== usage ledger ==');

await test('recordLlmUsage inserts a per-prospect row with sanitized fields', async () => {
  const db = mockDb();
  await recordLlmUsage(db, { contactId: 12, provider: 'groq', model: 'openai/gpt-oss-20b', operation: 'copywriting_generate', status: '200', error: '', latencyMs: 420 });
  const insert = db.calls.find((c) => c.sql.includes('INSERT INTO llm_usage_log'));
  assert.ok(insert, 'usage row inserted');
  assert.equal(insert.args[0], 12);
  assert.equal(insert.args[1], 'groq');
  assert.equal(insert.args[3], 'copywriting_generate');
  assert.equal(insert.args[4], '200');
});

await test('recordLlmUsage never throws when the DB fails', async () => {
  const broken = { prepare: () => { throw new Error('db down'); } };
  await recordLlmUsage(broken, { contactId: 1, provider: 'groq' }); // must not throw
});

await test('llmCooldownStore reads and writes cooldown rows', async () => {
  const db = mockDb({ first: { used: Date.now() + 60000 } });
  const store = llmCooldownStore(db);
  assert.equal(await store.isCoolingDown('groq'), true);
  const db2 = mockDb({ first: undefined });
  const store2 = llmCooldownStore(db2);
  assert.equal(await store2.isCoolingDown('groq'), false);
  await store2.markCooldown('groq', 5000, 'HTTP 429');
  const mark = db2.calls.find((c) => c.sql.includes('INSERT INTO provider_usage'));
  assert.ok(mark);
  assert.match(mark.args[0], /^llm_cooldown:groq$/);
});

/* ------------------------------------------------------------ summary */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

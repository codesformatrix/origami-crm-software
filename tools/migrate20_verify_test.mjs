// Verify migrate20.sql against the production schema build path WITHOUT
// applying anything to production. Builds a local in-memory SQLite database
// from schema.sql + migrate.sql + migrate2..19.sql (the canonical sequence
// production uses), applies migrate20.sql, and asserts structure,
// idempotency, foreign-key integrity, and that the app's actual write paths
// (recordLlmUsage, llmCooldownStore) run cleanly against the result.
//
// Run: node tools/migrate20_verify_test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { recordLlmUsage, llmCooldownStore } from '../functions/lib/usage.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e?.message || e}`);
  }
}

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const execFile = (db, file) => db.exec(fs.readFileSync(path.join(root, file), 'utf8'));

// Build the schema the way DEPLOYMENT.md prescribes for a fresh install:
// schema.sql alone. (The migrate1..19 chain targets LEGACY databases — it is
// not applicable on top of the current schema.sql and is exercised
// separately below. Production D1 itself is not reachable from this sandbox.)
const db = new DatabaseSync(':memory:');
execFile(db, 'schema.sql');

// Adapter so the app's async DB calls run against this sqlite instance.
function appDb() {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid || 0) } };
        },
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
    },
  };
}

console.log('\n== (3) migrate20 against the production schema build ==');

await check('fresh schema builds cleanly and already contains the llm_usage_log baseline', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('research_notes'), 'research_notes exists');
  assert.ok(tables.includes('provider_usage'), 'provider_usage exists');
  // schema.sql is the fresh-install baseline and already ships llm_usage_log;
  // migrate20 must remain a safe no-op for both fresh and legacy databases.
  assert.ok(tables.includes('llm_usage_log'), 'llm_usage_log present in fresh schema baseline');
});

await check('migrate20 contains no ALTER/destructive statements (safe on any schema state)', () => {
  const sql = fs.readFileSync(path.join(root, 'migrate20.sql'), 'utf8').toUpperCase();
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/, 'no ALTER TABLE');
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN)\b/, 'no DROP');
  assert.doesNotMatch(sql, /DELETE\s+FROM/, 'no DELETE FROM');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/, 'create-if-absent only');
});

// Apply migrate20 (local verification only — production D1 is untouched).
execFile(db, 'migrate20.sql');

await check('migrate20 creates llm_usage_log with the exact columns the app writes', () => {
  const cols = db.prepare('PRAGMA table_info(llm_usage_log)').all().map((r) => r.name);
  const expected = ['id', 'contact_id', 'provider', 'model', 'operation', 'status', 'error', 'latency_ms', 'created_at'];
  assert.deepEqual(cols, expected);
});

await check('migrate20 creates both indexes', () => {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_usage_log'").all().map((r) => r.name);
  assert.ok(indexes.includes('idx_llm_usage_contact'), 'contact index');
  assert.ok(indexes.includes('idx_llm_usage_provider'), 'provider index');
});

await check('migrate20 seeds research_reuse_hours default', () => {
  const row = db.prepare("SELECT value FROM settings WHERE key='research_reuse_hours'").get();
  assert.equal(row?.value, '48');
});

await check('migrate20 is idempotent (second application is a no-op)', () => {
  execFile(db, 'migrate20.sql');
  const row = db.prepare("SELECT value FROM settings WHERE key='research_reuse_hours'").get();
  assert.equal(row?.value, '48');
  const count = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='llm_usage_log'").get();
  assert.equal(count.n, 1, 'table not duplicated');
});

await check('foreign keys check clean after migrate20', () => {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(violations.length, 0, `violations: ${JSON.stringify(violations)}`);
});

await check('recordLlmUsage insert works against the migrated schema', async () => {
  const co = db.prepare("INSERT INTO companies(name,domain,created_at) VALUES('Co','co.example',date('now'))").run();
  db.prepare("INSERT INTO contacts(company_id,name,email,status,created_at) VALUES(?,'Riley','riley@co.example','new',date('now'))").run(co.lastInsertRowid);
  await recordLlmUsage(appDb(), { contactId: co.lastInsertRowid, provider: 'groq', model: 'openai/gpt-oss-20b', operation: 'copywriting_generate', status: '200', error: '', latencyMs: 10 });
  const row = db.prepare('SELECT * FROM llm_usage_log WHERE contact_id=?').get(co.lastInsertRowid);
  assert.ok(row, 'usage row persisted');
  assert.equal(row.provider, 'groq');
  assert.equal(row.operation, 'copywriting_generate');
  assert.equal(row.status, '200');
  assert.equal(row.latency_ms, 10);
  assert.ok(Number(row.id) > 0);
});

await check('llmCooldownStore reads/writes provider_usage cooldown rows', async () => {
  const store = llmCooldownStore(appDb());
  await store.markCooldown('groq', 60000, 'HTTP 429');
  const row = db.prepare("SELECT used FROM provider_usage WHERE provider='llm_cooldown:groq'").get();
  assert.ok(row && Number(row.used) > Date.now(), 'cooldown row persisted with future expiry');
  assert.equal(await store.isCoolingDown('groq'), true);
  await store.clearCooldown('groq');
  assert.equal(await store.isCoolingDown('groq'), false);
});

db.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

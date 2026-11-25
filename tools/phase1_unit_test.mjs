import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enqueueProspect, manualLinkedInResearch, runEnrichmentBatch } from '../functions/lib/enrichment.js';

function makeDB() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = {
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
  return DB;
}
async function insertFixture(DB, name = 'Riley Example', email = '') {
  const company = await DB.prepare("INSERT INTO companies(name,domain,website,employees,what_they_do,created_at) VALUES(?,?,?,?,?,date('now'))")
    .bind('Northstar Software', 'northstar.example', 'https://northstar.example', '80', 'B2B software platform').run();
  const companyId = company.meta.last_row_id;
  const contact = await DB.prepare("INSERT INTO contacts(company_id,name,title,email,linkedin,status,cadence,created_at) VALUES(?,?,?,?,?,'new',4,date('now'))")
    .bind(companyId, name, 'CTO', email, 'https://www.linkedin.com/in/example').run();
  return { companyId, contactId: contact.meta.last_row_id };
}
const llmJson = JSON.stringify({
  summary: 'Northstar builds software for business teams. Public material signals a focus on product delivery. Further details should be validated directly.',
  pain_points: ['Public hiring suggests delivery needs.', 'Current architecture details are not disclosed.'],
  talking_points: ['Ask how the engineering team scales.', 'Explore delivery bottlenecks before suggesting services.'],
  icp_score: 84,
  icp_reason: 'Strong technology fit and apparent decision authority.'
});
let mode = 'normal';
let tavilyCalls = 0;
const calls = [];
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  calls.push({ url, options });
  const response = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('api.apollo.io')) {
    if (mode === 'email_429') return response({ error: 'quota' }, 429);
    return response({ person: { email: 'riley@northstar.example' } });
  }
  if (url.includes('api.hunter.io')) {
    if (mode === 'email_429') return response({ error: 'quota' }, 429);
    return response({ data: { email: 'riley@northstar.example' } });
  }
  if (url.includes('api.firecrawl.dev')) {
    const body = JSON.parse(options.body || '{}');
    assert.match(body.url, /^https:\/\/northstar\.example/);
    assert.equal((body.formats || []).includes('markdown'), true);
    return response({ success: true, data: { markdown: `Northstar public company information for ${body.url}.` } });
  }
  if (url.includes('api.tavily.com')) {
    tavilyCalls++;
    if (mode === 'tavily_429_second' && tavilyCalls === 2) return response({ error: 'quota exhausted' }, 429);
    return response({ results: [
    { title: 'Indexed LinkedIn result', url: 'https://www.linkedin.com/posts/automated-result', content: 'LINKEDIN_RESULT_MUST_NOT_ENTER_AUTOMATIC_RESEARCH' },
    { title: 'Public result', url: 'https://news.example/item', content: 'Publicly indexed company and prospect information.' },
  ] });
  }
  if (url.includes('google.serper.dev')) return response({ organic: [{ title: 'Serper result', link: 'https://news.example/serper', snippet: 'Public search result content.' }] });
  if (url.includes('api.groq.com')) return response({ choices: [{ message: { content: llmJson } }] });
  throw new Error('Unexpected external request: ' + url);
};

// Full enrichment path: email match, three allowed company pages, two basic searches, synthesis.
{
  const DB = makeDB();
  const f = await insertFixture(DB);
  await enqueueProspect(DB, f.contactId);
  const env = { DB, APOLLO_API_KEY: 'test-only', HUNTER_API_KEY: 'test-only', FIRECRAWL_API_KEY: 'test-only', TAVILY_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' };
  mode = 'normal'; calls.length = 0;
  const out = await runEnrichmentBatch(env, 1);
  assert.equal(out.processed, 1);
  assert.equal(out.results[0].status, 'completed');
  assert.equal(calls.filter((x) => x.url.includes('api.firecrawl.dev')).length, 3, 'only homepage/about/blog are scraped');
  assert.equal(calls.filter((x) => x.url.includes('api.tavily.com')).length, 2, 'two public searches are made');
  assert.equal(calls.filter((x) => x.url.includes('api.apollo.io')).length, 1);
  assert.equal(calls.some((x) => /linkedin\.com/i.test(x.url)), false, 'no LinkedIn URL is fetched');
  const automaticPrompt = JSON.parse(calls.find((x) => x.url.includes('api.groq.com')).options.body).messages.map((m) => m.content).join(' ');
  assert.equal(automaticPrompt.includes('LINKEDIN_RESULT_MUST_NOT_ENTER_AUTOMATIC_RESEARCH'), false, 'automatic public research excludes LinkedIn results');
  const saved = await DB.prepare('SELECT email,email_discovery_status FROM contacts WHERE id=?').bind(f.contactId).first();
  assert.equal(saved.email, 'riley@northstar.example');
  assert.equal(saved.email_discovery_status, 'found');
  const note = await DB.prepare('SELECT * FROM research_notes WHERE contact_id=?').bind(f.contactId).first();
  assert.equal(note.source_type, 'research_synthesis');
  assert.equal(note.icp_score, 84);
  assert.equal(JSON.parse(note.pain_points).length, 2);
  assert.equal(JSON.parse(note.talking_points).length, 2);
  assert.equal((await DB.prepare('SELECT status,progress FROM enrichment_jobs WHERE contact_id=?').bind(f.contactId).first()).status, 'completed');
  DB.close();
}

// Missing email: one manual task and persisted needs_manual_email; no Apollo/Hunter calls.
{
  const DB = makeDB();
  const f = await insertFixture(DB, 'Sam Missing Email');
  await enqueueProspect(DB, f.contactId);
  calls.length = 0;
  await runEnrichmentBatch({ DB, FIRECRAWL_API_KEY: 'test-only', TAVILY_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' }, 1);
  const contact = await DB.prepare('SELECT email_discovery_status FROM contacts WHERE id=?').bind(f.contactId).first();
  assert.equal(contact.email_discovery_status, 'needs_manual_email');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE contact_id=? AND done=0').bind(f.contactId).first()).n, 1);
  assert.equal(calls.some((x) => x.url.includes('apollo.io') || x.url.includes('hunter.io')), false);
  DB.close();
}

// Tavily quota preflight sends both queries to Serper instead; no Tavily request leaks through.
{
  const DB = makeDB();
  const f = await insertFixture(DB, 'Taylor Search Fallback', 'taylor@northstar.example');
  await DB.prepare("UPDATE settings SET value='1' WHERE key='tavily_daily_cap'").run();
  await enqueueProspect(DB, f.contactId);
  calls.length = 0;
  await runEnrichmentBatch({ DB, FIRECRAWL_API_KEY: 'test-only', TAVILY_API_KEY: 'test-only', SERPER_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' }, 1);
  assert.equal(calls.filter((x) => x.url.includes('api.tavily.com')).length, 0);
  assert.equal(calls.filter((x) => x.url.includes('google.serper.dev')).length, 2);
  DB.close();
}

// Tavily HTTP quota exhaustion after one useful result switches the remaining query to Serper.
{
  const DB = makeDB();
  const f = await insertFixture(DB, 'Morgan Tavily Fallback', 'morgan@northstar.example');
  await enqueueProspect(DB, f.contactId);
  calls.length = 0; tavilyCalls = 0; mode = 'tavily_429_second';
  await runEnrichmentBatch({ DB, FIRECRAWL_API_KEY: 'test-only', TAVILY_API_KEY: 'test-only', SERPER_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' }, 1);
  assert.equal(calls.filter((x) => x.url.includes('api.tavily.com')).length, 2);
  assert.equal(calls.filter((x) => x.url.includes('google.serper.dev')).length, 1, 'Serper fills the remaining query after Tavily quota exhaustion');
  DB.close(); mode = 'normal';
}

// Provider HTTP 429 results in one Apollo and one Hunter call, never a paid-quota retry.
{
  const DB = makeDB();
  const f = await insertFixture(DB, 'Jordan Quota Case');
  await enqueueProspect(DB, f.contactId);
  calls.length = 0; mode = 'email_429';
  await runEnrichmentBatch({ DB, APOLLO_API_KEY: 'test-only', HUNTER_API_KEY: 'test-only', FIRECRAWL_API_KEY: 'test-only', TAVILY_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' }, 1);
  assert.equal(calls.filter((x) => x.url.includes('api.apollo.io')).length, 1);
  assert.equal(calls.filter((x) => x.url.includes('api.hunter.io')).length, 1);
  assert.equal((await DB.prepare('SELECT email_discovery_status FROM contacts WHERE id=?').bind(f.contactId).first()).email_discovery_status, 'needs_manual_email');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE contact_id=?').bind(f.contactId).first()).n, 1);
  DB.close(); mode = 'normal';
}

// Manually pasted LinkedIn text is summarized and stored under linkedin_manual without any LinkedIn fetch.
{
  const DB = makeDB();
  const f = await insertFixture(DB, 'Casey Manual Post', 'casey@northstar.example');
  calls.length = 0;
  const note = await manualLinkedInResearch({ DB, GROQ_API_KEY: 'test-only' }, f.contactId, {
    url: 'https://www.linkedin.com/posts/casey_example-123',
    text: 'We are hiring engineers to modernize our cloud platform and shorten feature delivery cycles.'
  });
  assert.equal(note.icp_score, 84);
  assert.equal((await DB.prepare('SELECT source_type,source_url FROM research_notes WHERE contact_id=?').bind(f.contactId).first()).source_type, 'linkedin_manual');
  assert.equal(calls.some((x) => /linkedin\.com/i.test(x.url)), false, 'manual URL is stored but never fetched');
  calls.length = 0;
  await manualLinkedInResearch({ DB, TAVILY_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' }, f.contactId, {
    url: 'https://www.linkedin.com/posts/casey_example-123'
  });
  assert.equal(calls.filter((x) => x.url.includes('api.tavily.com')).length, 1, 'URL-only manual input may use public search snippets');
  assert.equal(calls.some((x) => /linkedin\.com/i.test(x.url)), false, 'URL-only path never fetches LinkedIn directly');
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM research_notes WHERE contact_id=? AND source_type='linkedin_manual'").bind(f.contactId).first()).n, 2);
  await assert.rejects(() => manualLinkedInResearch({ DB, GROQ_API_KEY: 'test-only' }, f.contactId, { url: 'https://example.com/post' }), /Only a LinkedIn URL/);
  DB.close();
}

// Persistent hourly cap: even direct/manual batch calls cannot process more than 10 in one hour.
{
  const DB = makeDB();
  for (let i = 0; i < 11; i++) {
    const f = await insertFixture(DB, `Hourly Prospect ${i}`);
    await enqueueProspect(DB, f.contactId);
  }
  calls.length = 0;
  const out = await runEnrichmentBatch({ DB, FIRECRAWL_API_KEY: 'test-only', TAVILY_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' }, 10);
  assert.equal(out.processed, 10);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM enrichment_jobs WHERE status='queued'").first()).n, 1);
  assert.equal((await DB.prepare("SELECT used FROM provider_usage WHERE provider='enrichment' AND window_type='hour'").first()).used, 10);
  DB.close();
}

console.log('PASS Phase 1 enrichment, quotas, fallback, manual LinkedIn policy, email tasks, and hourly cap');

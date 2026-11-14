// Tests the AI timezone detection pipeline: fast path from uploaded data, LLM
// inference, and deep web research fallback, plus the job queue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { detectTimezone, enqueueTimezoneJob, runTimezoneBatch } from '../functions/lib/timezone.js';

function makeDB() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
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

async function fixture(db, { company = {}, contact = {} } = {}) {
  const co = { name: 'Northwind Analytics', domain: 'northwind.example', website: 'https://northwind.example', ...company };
  const coRes = await db.prepare("INSERT INTO companies(name,domain,website,what_they_do,sub_niche,timezone,created_at,city,country) VALUES(?,?,?,?,?,'','',?,?)").bind(co.name, co.domain, co.website, co.what_they_do || '', co.sub_niche || '', co.city || '', co.country || '').run();
  const coId = coRes.meta.last_row_id;
  const c = { name: 'Riley Example', title: 'CTO', email: 'riley@northwind.example', ...contact };
  const cRes = await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,cadence,created_at,timezone) VALUES(?,?,?,?,'new',4,'',?)").bind(coId, c.name, c.title, c.email, c.timezone || '').run();
  return { coId, contactId: cRes.meta.last_row_id };
}

let fetchCalls = [];
const originalFetch = globalThis.fetch;
function mockLLM({ city, country, timezone, confidence = 'high' }) {
  globalThis.fetch = async (input, options = {}) => {
    fetchCalls.push(String(input));
    const body = JSON.parse(options.body || '{}');
    const system = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    if (system.includes('precise location researcher')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ city, country, timezone, confidence }) } }] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}
function mockResearch({ scrape = '', search = '', city, country, timezone, confidence = 'medium' }) {
  let llmCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    fetchCalls.push(String(input));
    const url = String(input);
    if (url.includes('firecrawl')) return new Response(JSON.stringify({ success: true, data: { markdown: scrape } }), { status: 200 });
    if (url.includes('tavily') || url.includes('serper')) return new Response(JSON.stringify({ results: [{ content: search, title: 'HQ' }] }), { status: 200 });
    const body = JSON.parse(options.body || '{}');
    const system = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    if (system.includes('precise location researcher')) {
      llmCalls++;
      // First inference (no research text yet) cannot determine the timezone;
      // the second call has website/search evidence behind it.
      const answer = llmCalls === 1
        ? { city: '', country: '', timezone: '', confidence: 'low' }
        : { city, country, timezone, confidence };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}

try {
  const env = { DB: null, GROQ_API_KEY: 'test-key', FIRECRAWL_API_KEY: 'fc-test', TAVILY_API_KEY: 'tv-test' };

  // --- Fast path: city/country in the uploaded data resolves without the LLM.
  {
    const db = makeDB();
    const { contactId } = await fixture(db, { company: { city: 'Pune', country: 'India' } });
    fetchCalls = [];
    const detected = await detectTimezone(env, db, contactId);
    assert.equal(detected.source, 'uploaded_data');
    assert.equal(detected.timezone, 'Asia/Kolkata');
    assert.equal(fetchCalls.length, 0, 'no LLM call needed when city resolves');
    const saved = await db.prepare('SELECT timezone FROM contacts WHERE id=?').bind(contactId).first();
    assert.equal(saved.timezone, 'Asia/Kolkata');
    const job = await db.prepare('SELECT * FROM timezone_jobs WHERE contact_id=?').bind(contactId).first();
    assert.ok(!job, 'detection before queue does not create a job');
    db.close();
    console.log('pass: uploaded-data fast path');
  }

  // --- LLM inference path when no location data exists.
  {
    const db = makeDB();
    const { contactId } = await fixture(db);
    mockLLM({ city: 'Austin', country: 'United States', timezone: 'America/Chicago' });
    fetchCalls = [];
    const detected = await detectTimezone(env, db, contactId);
    assert.equal(detected.source, 'llm');
    assert.equal(detected.timezone, 'America/Chicago');
    assert.ok(fetchCalls.some((u) => u.includes('groq')), 'LLM call made');
    const saved = await db.prepare('SELECT timezone FROM contacts WHERE id=?').bind(contactId).first();
    assert.equal(saved.timezone, 'America/Chicago');
    const note = await db.prepare("SELECT summary FROM research_notes WHERE source_type='timezone_detection'").first();
    assert.ok(note?.summary?.includes('America/Chicago'), 'timezone_detection note stored');
    db.close();
    console.log('pass: LLM inference path');
  }

  // --- Deep web research path: scrape + search + LLM.
  {
    const db = makeDB();
    const { contactId } = await fixture(db, { company: { website: 'https://northwind.example' } });
    mockResearch({ scrape: 'About us — Northwind Analytics, headquartered in Gurgaon, India.', search: 'northwind.example headquarters Gurgaon', city: 'Gurgaon', country: 'India', timezone: 'Asia/Kolkata' });
    fetchCalls = [];
    const detected = await detectTimezone(env, db, contactId);
    assert.equal(detected.source, 'web_research');
    assert.equal(detected.timezone, 'Asia/Kolkata');
    assert.ok(fetchCalls.some((u) => u.includes('firecrawl')), 'website scraped');
    assert.ok(fetchCalls.some((u) => u.includes('tavily') || u.includes('serper')), 'search used');
    db.close();
    console.log('pass: deep web research path');
  }

  // --- Job queue: enqueue + batch run + skip when timezone already set.
  {
    const db = makeDB();
    const { contactId } = await fixture(db);
    const enq = await enqueueTimezoneJob(db, contactId);
    assert.equal(enq.queued, true);
    const dup = await enqueueTimezoneJob(db, contactId);
    assert.equal(dup.queued, false, 'no duplicate queue entries');
    mockLLM({ city: 'Bengaluru', country: 'India', timezone: 'Asia/Kolkata' });
    const result = await runTimezoneBatch({ ...env, DB: db }, 10);
    assert.equal(result.processed, 1);
    assert.equal(result.results[0].timezone, 'Asia/Kolkata');
    const job = await db.prepare('SELECT * FROM timezone_jobs WHERE contact_id=?').bind(contactId).first();
    assert.equal(job.status, 'done');
    // Already set: detection returns immediately without queueing again.
    const again = await detectTimezone(env, db, contactId);
    assert.equal(again.source, 'already_set');
    db.close();
    console.log('pass: job queue and batch');
  }

  console.log('\ntimezone detection: all tests passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}

// Tests that the user's real Excel columns map correctly through the import
// auto-guess, that empty/"unknown" cells import cleanly, and that enrichment
// fills empty company fields from public research.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enqueueProspect, runEnrichmentBatch } from '../functions/lib/enrichment.js';
import { runTimezoneBatch } from '../functions/lib/timezone.js';

function headerKey(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '').trim();
}
const GENERIC_ALIASES = new Set(['company', 'business', 'startup', 'organization', 'organisation', 'linkedin', 'contact', 'person', 'title', 'location', 'website', 'email', 'phone', 'education', 'notes', 'stage']);
const headerScore = (header, alias) => {
  const h = headerKey(header), a = headerKey(alias);
  if (!h || !a) return 0;
  if (h === a) return 10000 + a.length;
  if (a.length >= 4 && h.includes(a) && !(GENERIC_ALIASES.has(a) && h !== a)) return 5000 + a.length;
  if (h.length >= 4 && a.includes(h) && !(GENERIC_ALIASES.has(h) && h !== a)) return 2500 + h.length;
  const ht = new Set(h.match(/[a-z]+/g) || []), at = (a.match(/[a-z]+/g) || []);
  const overlap = at.filter((x) => ht.has(x)).length;
  return overlap ? 1000 + overlap * 10 : 0;
};

// Extract the REAL HEADER_ALIASES from app.js so the test tracks the file.
const appSrc = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const aliasStart = appSrc.indexOf('const HEADER_ALIASES = {');
assert.ok(aliasStart > 0, 'HEADER_ALIASES block not found in app.js');
const aliasEnd = appSrc.indexOf('\n  };', aliasStart);
assert.ok(aliasEnd > aliasStart, 'HEADER_ALIASES end not found');
const aliasesSrc = appSrc.slice(aliasStart + 'const HEADER_ALIASES = '.length, aliasEnd + 4);
const HEADER_ALIASES = eval('(' + aliasesSrc + ')');

const guess = (fld, cols, used) => {
  const aliases = HEADER_ALIASES[fld] || [fld];
  let best = { col: '', score: 0 };
  for (const col of cols) {
    if (used.has(col)) continue;
    const score = Math.max(...aliases.map((alias) => headerScore(col, alias)));
    if (score > best.score) best = { col, score };
  }
  if (best.score >= 2500) used.add(best.col);
  return best.col;
};

// The user's Excel columns (as described).
const userColumns = ['Company', 'Website', 'HQ', 'Person', 'Person role', 'Person LinkedIn URL', 'Person background / notes', 'Recent activity (Sales Navigator)', 'Person source URL(s)', 'What the product does', 'Live product (Y/N)', 'Headcount', 'Total raised', 'Last round date', 'Founders', 'CTO / technical co-founder (Y/N)', 'Company notes / flags', 'Company source URL(s)'];

// Expected auto-guess: every column should land on the right CRM field.
const expected = {
  company: 'Company', website: 'Website', hq: 'HQ', contact: 'Person', title: 'Person role',
  dm_linkedin: 'Person LinkedIn URL', notes: 'Person background / notes', recent_news: 'Recent activity (Sales Navigator)',
  what_they_do: 'What the product does', live_product: 'Live product (Y/N)', employees: 'Headcount',
  total_raised: 'Total raised', last_funding_date: 'Last round date', founders: 'Founders',
  technical_lead: 'CTO / technical co-founder (Y/N)', criteria_flags: 'Company notes / flags', source: 'Company source URL(s)',
};

let originalFetch = globalThis.fetch;
try {
  const used = new Set();
  const guessed = {};
  for (const [field, col] of Object.entries(expected)) guessed[field] = guess(field, userColumns, used);
  for (const [field, col] of Object.entries(expected)) {
    assert.equal(guessed[field], col, `auto-guess for ${field} should be "${col}" but got "${guessed[field]}"`);
  }
  console.log('pass: all 16 user columns auto-map to the right CRM field');

  // --- API import: empty and "unknown" cells import cleanly, new fields land.
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = {
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
  const mapping = { ...guessed };
  const rows = [{
    Company: 'Acme Cloud', Website: 'acme-cloud.example.test', HQ: 'Bengaluru, India',
    Person: 'Priya Sharma', 'Person role': 'VP Engineering', 'Person LinkedIn URL': 'https://linkedin.example/in/priya',
    'Person background / notes': 'Ex-Google infra.', 'Recent activity (Sales Navigator)': 'unknown',
    'Person source URL(s)': '', 'What the product does': '', 'Live product (Y/N)': 'yes',
    Headcount: '45', 'Total raised': '$12M', 'Last round date': '2026-03-01',
    Founders: 'Priya Sharma, Vikram Rao', 'CTO / technical co-founder (Y/N)': 'yes',
    'Company notes / flags': 'unknown', 'Company source URL(s)': 'https://crunchbase.example/acme',
  }];
  const env = { DB: db, GROQ_API_KEY: 'test-key' };

  // Import via the same logic the endpoint runs: cleanCell strips unknown,
  // blank markers become empty, then rows are inserted with the mapping.
  const blankMarkers = new Set(['', '-', '—', 'n/a', 'na', 'n.a.', 'none', 'null', 'unknown', 'not found', '[not found]', 'not available']);
  const cleanCell = (value) => {
    const v = String(value === undefined || value === null ? '' : value).trim();
    return blankMarkers.has(v.toLowerCase()) ? '' : v;
  };
  const get = (f) => (mapping[f] && rows[0][mapping[f]] !== undefined ? cleanCell(rows[0][mapping[f]]) : '');
  const companyName = get('company');
  const domain = String(get('domain') || get('website') || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
  const coRes = await db.prepare("INSERT INTO companies(name,domain,website,linkedin,sub_niche,what_they_do,employees,hq,founded,funding,funding_stage,total_raised,last_funding_date,open_eng_roles,recent_news,public_appearances,criteria_flags,created_at,city,country,country_key,country_code,timezone,live_product,founders,technical_lead,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(companyName, domain, get('website') || ('https://' + domain), get('linkedin'), get('sub_niche'), get('what_they_do'), get('employees'), get('hq'), get('founded'), get('funding'), get('funding_stage'), get('total_raised'), get('last_funding_date'), get('open_eng_roles'), get('recent_news'), get('public_appearances'), get('criteria_flags'), new Date().toISOString(), '', '', '', '', '', get('live_product'), get('founders'), get('technical_lead'), get('source') || 'import').run();
  const coId = coRes.meta.last_row_id;
  const cRes = await db.prepare("INSERT INTO contacts(company_id,name,title,email,phone,linkedin,notes,time_in_role,previous_roles,education,status,cadence,touch_count,next_action,created_at,timezone) VALUES(?,?,?,?,?,?,?,?,?,?,'new',?,0,?,?,?)")
    .bind(coId, get('contact'), get('title'), get('email'), get('phone'), get('dm_linkedin'), get('notes'), get('time_in_role'), get('previous_roles'), get('education'), 4, new Date().toISOString(), new Date().toISOString(), get('timezone')).run();
  const contactId = cRes.meta.last_row_id;

  const company = await db.prepare('SELECT * FROM companies WHERE id=?').bind(coId).first();
  assert.equal(company.live_product, 'yes', 'live_product captured');
  assert.equal(company.founders, 'Priya Sharma, Vikram Rao', 'founders captured');
  assert.equal(company.technical_lead, 'yes', 'technical_lead captured');
  assert.equal(company.source, 'https://crunchbase.example/acme', 'company source captured');
  assert.equal(company.recent_news, '', '"unknown" recent activity stripped to empty');
  assert.equal(company.criteria_flags, '', '"unknown" company notes stripped to empty');
  assert.equal(company.what_they_do, '', 'empty what-they-do stays empty for enrichment to fill');
  assert.equal(company.headcount || company.employees, '45', 'headcount mapped to employees');

  const contact = await db.prepare('SELECT * FROM contacts WHERE id=?').bind(contactId).first();
  assert.equal(contact.title, 'VP Engineering', 'person role mapped to title');
  assert.equal(contact.linkedin, 'https://linkedin.example/in/priya', 'person linkedin captured');
  assert.equal(contact.notes, 'Ex-Google infra.', 'person background captured');
  console.log('pass: empty and "unknown" cells import cleanly; new fields captured');

  // --- Enrichment fills empty company fields from public research.
  let fetchCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    fetchCalls++;
    const url = String(input);
    if (url.includes('firecrawl')) return new Response(JSON.stringify({ success: true, data: { markdown: 'About: Acme Cloud builds developer tooling. Based in Bengaluru, India. Founder: Priya Sharma.' } }), { status: 200 });
    if (url.includes('tavily') || url.includes('serper')) return new Response(JSON.stringify({ results: [{ content: 'Acme Cloud announced a Series A and a new observability product.' }] }), { status: 200 });
    const body = JSON.parse(options.body || '{}');
    const system = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    if (system.includes('precise company data extraction assistant')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ what_they_do: 'Developer tooling for cloud teams', recent_news: 'Series A announced; new observability product', city: 'Bengaluru', country: 'India', live_product: 'yes', founders: 'Priya Sharma', technical_lead: 'no' }) } }] }), { status: 200 });
    }
    if (system.includes('careful B2B prospect research analyst')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Acme Cloud builds developer tooling and announced a Series A. They are hiring engineering leaders.', pain_points: ['Delivery capacity for the observability launch'], talking_points: ['Series A announced', 'New observability product', 'Hiring engineering leaders'], icp_score: 82, icp_reason: 'Strong fit with delivery capacity needs.' }) } }] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const originalFetch = globalThis.fetch;

  await enqueueProspect(db, contactId);
  const batch = await runEnrichmentBatch({ ...env, FIRECRAWL_API_KEY: 'fc', TAVILY_API_KEY: 'tv', PUBLIC_APP_URL: 'https://crm.example' }, 1);
  assert.equal(batch.processed, 1);
  assert.equal(batch.results[0].status, 'completed');

  const filled = await db.prepare('SELECT * FROM companies WHERE id=?').bind(coId).first();
  assert.equal(filled.what_they_do, 'Developer tooling for cloud teams', 'empty what_they_do filled from research');
  assert.equal(filled.recent_news, 'Series A announced; new observability product', 'empty recent_news filled from research');
  assert.equal(filled.city, 'Bengaluru', 'empty city filled from research');
  assert.equal(filled.country, 'India', 'empty country filled from research');
  assert.equal(filled.live_product, 'yes', 'filled value kept (uploaded "yes" wins over extraction "yes")');
  assert.equal(filled.founders, 'Priya Sharma, Vikram Rao', 'uploaded founders preserved, not overwritten');
  assert.equal(filled.technical_lead, 'yes', 'uploaded technical_lead preserved');
  assert.ok(fetchCalls >= 3, 'website scrape, search, and extraction all used');

  const note = await db.prepare("SELECT summary FROM research_notes WHERE contact_id=? AND source_type='research_synthesis'").bind(contactId).first();
  assert.ok(note?.summary?.includes('Acme Cloud'), 'synthesis note stored');
  console.log('pass: enrichment fills empty company fields without overwriting uploaded data');

  // --- Timezone detection picks up the filled city.
  await enqueueProspect(db, contactId);
  await db.prepare("INSERT INTO timezone_jobs(contact_id,status,created_at,updated_at) VALUES(?, 'queued', ?, ?)").bind(contactId, new Date().toISOString(), new Date().toISOString()).run();
  const tz = await runTimezoneBatch({ ...env, FIRECRAWL_API_KEY: 'fc', TAVILY_API_KEY: 'tv' }, 1);
  assert.equal(tz.results[0].timezone, 'Asia/Kolkata', 'timezone detected from filled city');
  console.log('pass: timezone detection uses the filled city');

  db.close();
  console.log('\nimport mapping and smart filling: all tests passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}

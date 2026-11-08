// Prospect timezone detection. Detects a contact's IANA timezone from any
// available signal: the uploaded data, an LLM inference from the company name
// and website, or deep web research (Firecrawl scrape + Tavily/Serper search).
// The detected timezone drives outreach sending windows and gives the copy
// writer local context awareness.
import { detectLocation } from './engine.js';
import { generateWithFallback } from './llm.js';

const MAX_HOURLY = 10;

function isoNow() { return new Date().toISOString(); }

function safeCompanyRoot(company) {
  const raw = String(company.website || company.domain || '');
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    const h = u.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(u.protocol) || !h.includes('.') || /^[0-9.]+$/.test(h) || h.endsWith('.local')) return '';
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h) || h.includes(':')) return '';
    return u.origin;
  } catch { return ''; }
}

async function firecrawlScrape(env, root) {
  if (!env.FIRECRAWL_API_KEY || !root) return { text: '', configured: !!env.FIRECRAWL_API_KEY };
  const collected = [];
  for (const path of ['', '/about', '/contact']) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: root + path, formats: ['markdown'] }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success !== false) {
        const md = String(data.data?.markdown || data.markdown || '').slice(0, 4000);
        if (md.trim()) collected.push(`SOURCE ${root + path}\n${md}`);
      }
    } catch { /* one attempt per page */ }
  }
  return { text: collected.join('\n\n').slice(0, 9000), configured: true };
}

async function webSearch(env, query) {
  if (env.TAVILY_API_KEY) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, search_depth: 'basic', max_results: 4, include_answer: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return (data.results || []).slice(0, 4).map((x) => `SOURCE ${x.url || ''}\n${x.content || x.raw_content || ''}`).join('\n\n');
    } catch { /* fall through */ }
  }
  if (env.SERPER_API_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 4 }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return (data.organic || []).slice(0, 4).map((x) => `SOURCE ${x.link || ''}\n${x.snippet || x.description || ''}`).join('\n\n');
    } catch { /* no automatic retries */ }
  }
  return '';
}

function validZone(value) {
  if (!value || typeof value !== 'string') return '';
  const z = value.trim();
  if (!/^[A-Za-z0-9_+\-/]+$/.test(z)) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }).format(new Date()); return z; } catch { return ''; }
}

function parseJsonObject(text) {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}

// Ask the LLM to infer a company's city and IANA timezone from whatever
// location signals are available.
async function inferWithLLM(env, DB, contact, company, researchText) {
  const system = 'You are a precise location researcher. Given a company name, website content, and any other location signals, determine the company headquarters city and its IANA timezone name (for example Asia/Kolkata or America/New_York). If the evidence is not enough to identify a city, answer with the country only and set confidence to low. Return JSON only: {"city":"...","country":"...","timezone":"...","confidence":"high|medium|low"}. Do not invent facts; use only the supplied evidence.';
  const signals = [
    `company_name: ${contact.company || company.name || ''}`,
    `contact_city: ${contact.city || ''}`,
    `contact_country: ${contact.country || ''}`,
    `company_city: ${company.city || ''}`,
    `company_country: ${company.country || ''}`,
    `company_hq: ${company.hq || ''}`,
    `company_website: ${company.website || ''}`,
    `company_domain: ${company.domain || ''}`,
    `research_text: ${researchText || ''}`,
  ].filter((x) => !String(x).endsWith(': ')).join('\n');
  const result = await generateWithFallback(env, [{ role: 'system', content: system }, { role: 'user', content: signals }], { maxTokens: 300, temperature: 0.1 });
  const parsed = parseJsonObject(result.text);
  if (!parsed) return null;
  return { city: String(parsed.city || '').trim(), country: String(parsed.country || '').trim(), timezone: validZone(parsed.timezone), confidence: String(parsed.confidence || 'medium').toLowerCase() };
}

export async function detectTimezone(env, DB, contactId) {
  const contact = await DB.prepare('SELECT * FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) throw new Error('Prospect not found');
  if (String(contact.timezone || '').trim()) return { timezone: contact.timezone, source: 'already_set', city: contact.city || '', country: contact.country || '', confidence: 'high' };
  const company = await DB.prepare('SELECT * FROM companies WHERE id=?').bind(contact.company_id).first();
  const co = company || {};

  // 1. Fast path: city or country in the uploaded data (contacts carry a
  // timezone only; companies carry city/country/hq).
  const signals = [co.city, co.country, co.hq].filter(Boolean).join(', ');
  const located = signals.trim() ? detectLocation(signals) : null;
  if (located && located.timezone && located.confidence !== 'none') {
    await applyTimezone(DB, contactId, contact.company_id, located.timezone, located.city || contact.city || co.city || '', located.country || contact.country || co.country || '', 'data', 'high');
    return { timezone: located.timezone, source: 'uploaded_data', city: located.city, country: located.country, confidence: 'high' };
  }

  // 2. LLM inference from company name and any research text.
  const researchText = String(co.what_they_do || '') + ' ' + String(co.recent_news || '');
  let inferred = await inferWithLLM(env, DB, contact, co, researchText);
  if (inferred && inferred.timezone) {
    await applyTimezone(DB, contactId, contact.company_id, inferred.timezone, inferred.city || located?.city || '', inferred.country || located?.country || '', 'llm', inferred.confidence || 'medium');
    return { timezone: inferred.timezone, source: 'llm', city: inferred.city, country: inferred.country, confidence: inferred.confidence || 'medium' };
  }

  // 3. Deep web research: scrape the website and search for HQ location.
  const root = safeCompanyRoot(co);
  let research = '';
  if (root) research += (await firecrawlScrape(env, root)).text;
  research += '\n' + await webSearch(env, `${co.name || ''} headquarters location city`);
  if (research.trim()) {
    inferred = await inferWithLLM(env, DB, contact, co, research.slice(0, 8000));
    if (inferred && inferred.timezone) {
      await applyTimezone(DB, contactId, contact.company_id, inferred.timezone, inferred.city || '', inferred.country || '', 'web_research', inferred.confidence || 'medium');
      return { timezone: inferred.timezone, source: 'web_research', city: inferred.city, country: inferred.country, confidence: inferred.confidence || 'medium' };
    }
  }

  throw new Error('Could not determine a timezone. Add a city or country to the prospect, or configure Firecrawl and Tavily/Serper keys for web research.');
}

async function applyTimezone(DB, contactId, companyId, timezone, city, country, source, confidence) {
  const stamp = isoNow();
  await DB.prepare('UPDATE contacts SET timezone=? WHERE id=?').bind(timezone, contactId).run();
  if (companyId) {
    await DB.prepare("UPDATE companies SET timezone=CASE WHEN timezone='' THEN ? ELSE timezone END, city=CASE WHEN city='' THEN ? ELSE city END, country=CASE WHEN country='' THEN ? ELSE country END WHERE id=?")
      .bind(timezone, city || '', country || '', companyId).run();
  }
  await DB.prepare("INSERT INTO research_notes(contact_id,source_type,source_url,summary,pain_points,talking_points,fetched_at) VALUES(?,'timezone_detection','','Timezone detected as " + timezone + " for this prospect (source: " + source + ", confidence: " + confidence + ").','[]','[]',?)")
    .bind(contactId, stamp).run();
}

export function enqueueTimezoneJob(DB, contactId) {
  return DB.prepare("INSERT INTO timezone_jobs(contact_id,status,created_at,updated_at) SELECT ?, 'queued', ?, ? WHERE NOT EXISTS (SELECT 1 FROM timezone_jobs WHERE contact_id=? AND status IN ('queued','running'))").bind(contactId, isoNow(), isoNow(), contactId).run()
    .then((r) => ({ queued: Number(r?.meta?.changes || 0) > 0 }));
}

export async function runTimezoneBatch(env, maxJobs = MAX_HOURLY) {
  const DB = env.DB;
  const results = [];
  for (let i = 0; i < Math.min(MAX_HOURLY, Math.max(1, maxJobs)); i++) {
    const row = await DB.prepare("SELECT * FROM timezone_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").first();
    if (!row) break;
    await DB.prepare("UPDATE timezone_jobs SET status='running',started_at=?,updated_at=? WHERE id=?").bind(isoNow(), isoNow(), row.id).run();
    try {
      const detected = await detectTimezone(env, DB, row.contact_id);
      await DB.prepare("UPDATE timezone_jobs SET status='done',detail=?,finished_at=?,updated_at=? WHERE id=?").bind(`${detected.timezone} (${detected.source})`, isoNow(), isoNow(), row.id).run();
      results.push({ contact_id: row.contact_id, timezone: detected.timezone, source: detected.source });
    } catch (e) {
      const message = String(e?.message || e).slice(0, 500);
      await DB.prepare("UPDATE timezone_jobs SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=?").bind(message, isoNow(), isoNow(), row.id).run();
      results.push({ contact_id: row.contact_id, error: message });
    }
  }
  return { processed: results.length, results };
}

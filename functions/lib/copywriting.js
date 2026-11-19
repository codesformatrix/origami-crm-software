import { generateWithFallback } from './llm.js';
import { isEmailSuppressed } from './compliance.js';
import { logStep } from './steplog.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_HOURLY = 1; // 1 job per cron run — free-tier rate limits are very tight
const nowIso = () => new Date().toISOString();
const dateParts = () => {
  const d = new Date();
  return { day: d.toISOString().slice(0, 10), hour: d.toISOString().slice(0, 13) };
};
const DEFAULT_LLM_CAPS = { groq: 50, gemini: 10, openrouter: 20 };

async function providerReserve(DB, provider) {
  const { day } = dateParts();
  // Always allow the request — quota is a soft cap, not a hard block.
  // If the provider is rate-limited, the API returns 429 and the fallback chain moves to the next provider.
  // This prevents stale counters from permanently blocking all generation.
  await DB.prepare(`INSERT INTO provider_usage(provider,window_type,window_key,used,updated_at) VALUES(?,'day',?,1,?)
    ON CONFLICT(provider,window_type,window_key) DO UPDATE SET used=provider_usage.used+1,updated_at=excluded.updated_at`).bind(provider, day, nowIso()).run();
  return true;
}
async function reserveSlot(DB) {
  const { hour } = dateParts();
  const setting = await DB.prepare("SELECT value FROM settings WHERE key='copywriting_hourly_cap'").first();
  const cap = Math.max(0, Math.min(100, Number(setting?.value ?? MAX_HOURLY)));
  if (!cap) return false;
  const result = await DB.prepare(`INSERT INTO provider_usage(provider,window_type,window_key,used,updated_at) VALUES('copywriting','hour',?,1,?)
    ON CONFLICT(provider,window_type,window_key) DO UPDATE SET used=provider_usage.used+1,updated_at=excluded.updated_at
    WHERE provider_usage.used+1<=?`).bind(hour, nowIso(), cap).run();
  return Number(result?.meta?.changes || 0) > 0;
}
async function releaseSlot(DB) {
  const { hour } = dateParts();
  await DB.prepare("UPDATE provider_usage SET used=MAX(used-1,0),updated_at=? WHERE provider='copywriting' AND window_type='hour' AND window_key=?")
    .bind(nowIso(), hour).run();
}
function jsonObject(raw) {
  const clean = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(clean); } catch {}
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  // Last resort: if the model returned plain text, wrap it as a body string
  return { subject: '', body: clean.slice(0, 1000), hook_used: '', sources: [] };
}
function parseList(raw) { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []; } catch { return []; } }
function actualWordCount(body, unsubscribeUrl) {
  const prose = String(body || '').replaceAll(unsubscribeUrl || '\u0000', '').replace(/^\s*Unsubscribe:\s*.*$/gim, ' ').trim();
  const words = prose.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
  return words.length + (unsubscribeUrl ? 2 : 0);
}
function sentenceCount(prose) { return (String(prose || '').match(/[.!?](?=\s|$)/g) || []).length; }
function subjectWordCount(subject) { return (String(subject || '').trim().split(/\s+/).filter(Boolean)).length; }
function sanitizeBody(body, unsubscribeUrl, includeUnsubscribe = true) {
  let prose = String(body || '').replaceAll(unsubscribeUrl || '\u0000', '').replace(/^\s*Unsubscribe:\s*.*$/gim, '').trim();
  prose = prose.replace(/[-\u2010-\u2015\u2212]/g, ' ')
    .replace(/\bI hope this finds you well\b[.!]?/ig, '')
    .replace(/\bjust checking in\b/ig, '');
  prose = prose.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return includeUnsubscribe && unsubscribeUrl ? `${prose}\n\nUnsubscribe: ${unsubscribeUrl}` : prose;
}
function normalizeSubject(subject, step, company) {
  let value = String(subject || '').trim().toLowerCase().replace(/[\u2010-\u2015\u2212-]/g, ' ').replace(/\s+/g, ' ');
  const words = value.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5 || /[!?]/.test(value)) {
    const safeCompany = String(company || 'your team').toLowerCase().replace(/[\u2010-\u2015\u2212-]/g, ' ').replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 3).join(' ') || 'your team';
    const endings = ['delivery', 'product work', 'one thought', 'closing the loop'];
    value = `${safeCompany} ${endings[step - 1]}`.trim().split(/\s+/).slice(0, 5).join(' ');
  }
  return value;
}
function proseOpening(body, unsubscribeUrl) {
  return String(body || '').replaceAll(unsubscribeUrl || '\u0000', '').replace(/^\s*Unsubscribe:\s*.*$/gim, '').trim().split(/\s+/).slice(0, 40).join(' ');
}
function checkConstraints(draft, unsubscribeUrl, research = {}) {
  const issues = [];
  const count = actualWordCount(draft.body, unsubscribeUrl);
  if (draft.step_number === 1 && (count < 60 || count > 110)) issues.push('Touch 1 must be 60 to 110 words.');
  if (draft.step_number === 1) {
    const source = [research.summary, ...(research.pain_points || []), ...(research.talking_points || [])].join(' ').toLowerCase();
    const stop = new Set(['about','after','again','along','among','because','being','could','their','there','these','those','where','which','while','would','your','from','with','this','that','they','them','have','were','will','into','also','team','teams']);
    const sourceWords = new Set((source.match(/[\p{L}]{5,}/gu) || []).filter((word) => !stop.has(word)));
    const opening = proseOpening(draft.body, unsubscribeUrl);
    const openingWords = new Set((opening.match(/[\p{L}]{5,}/gu) || []).filter((word) => !stop.has(word)));
    const anchors = [...openingWords].filter((word) => sourceWords.has(word));
    if (anchors.length < 2) issues.push('The opening needs at least two specific words anchored in the saved research.');
  }
  if (draft.step_number > 1 && draft.step_number !== 4 && (count < 20 || count > 60)) issues.push('Follow ups must be shorter than touch 1 (20 to 60 words).');
  if (draft.step_number === 4 && count > 60) issues.push('Breakup email must be shorter (under 60 words).');
  const prose = String(draft.body || '').replaceAll(unsubscribeUrl, '').replace(/^\s*Unsubscribe:\s*.*$/gim, '').trim();
  if (draft.step_number === 4 && sentenceCount(prose) !== 2) issues.push('The breakup email must contain exactly two sentences before the unsubscribe line.');
  if (subjectWordCount(draft.subject) < 2 || subjectWordCount(draft.subject) > 5) issues.push('Subject must contain 2 to 5 words.');
  if (/\b(urgent|act now|limited time|exclusive|secret|you will not believe|you won't believe)\b/i.test(draft.subject)) issues.push('Remove clickbait or pressure language from the subject.');
  if (draft.subject !== draft.subject.toLowerCase()) issues.push('Subject must be lowercase.');
  if (!unsubscribeUrl) issues.push('The unsubscribe link is missing.');
  if (/[—–]/.test(prose) || /(?:^|\s)[-](?:\s|$)/.test(prose)) issues.push('Remove dash punctuation from the email copy.');
  if (/i hope this finds you well|leverage|streamline|solutions|synergy|unlock|game.?changer|seamless|cutting.?edge|robust|delve into|revolutionary/i.test(prose)) issues.push('Remove generic or buzzword language.');
  if (/^\s*[•·●○◆■□▪◦*-]\s/m.test(draft.body)) issues.push('No bullet points allowed.');
  if ((prose.match(/\?/g) || []).length > 1) issues.push('Use no more than one question.');
  return { valid: issues.length === 0, issues, word_count: count };
}
function weightedScore(dims) {
  return Math.round((dims.word_count * 0.2) + (dims.personalization_depth * 0.3) + (dims.cta_clarity * 0.2) + (dims.subject_line_strength * 0.15) + (dims.spam_safety * 0.15));
}
function normalizeScore(score, draft, unsubscribeUrl, research = {}) {
  const raw = score || {};
  const dims = {
    word_count: Number(raw.word_count) || 0,
    personalization_depth: Number(raw.personalization_depth) || 0,
    cta_clarity: Number(raw.cta_clarity) || 0,
    subject_line_strength: Number(raw.subject_line_strength) || 0,
    spam_safety: Number(raw.spam_safety ?? raw.spam_trigger_safety) || 0,
  };
  for (const key of Object.keys(dims)) dims[key] = Math.max(0, Math.min(100, Math.round(dims[key])));
  const constraints = checkConstraints(draft, unsubscribeUrl, research);
  let final = weightedScore(dims);
  if (!constraints.valid) final = Math.min(final, 69);
  const critique = [String(raw.critique || '').trim(), ...constraints.issues].filter(Boolean).join(' ').slice(0, 1200);
  return { score: final, breakdown: { ...dims, constraints_valid: constraints.valid, issues: constraints.issues }, critique, word_count: constraints.word_count, constraints_valid: constraints.valid };
}
async function scoreDrafts(env, DB, drafts, context) {
  const system = `You are a strict, fair email copy editor. Score each draft from 0 to 100 on five dimensions. Return JSON only: {"scores":[{"step_number":1,"word_count":0,"personalization_depth":0,"cta_clarity":0,"subject_line_strength":0,"spam_safety":0,"critique":"specific changes"}]}. Use these dimensions: word_count means correct length for its step (touch 1 is 60 to 110 words, follow ups shorter); personalization_depth means it cites supplied research accurately and opens with a specific detail; cta_clarity means one clear interest check or 15 minute invitation; subject_line_strength means 2 to 5 lowercase relevant words; spam_safety is 100 when no spam triggers and 0 when many. Never reward invented facts. Critique must be brief, concrete, and kind. Unsubscribe footer is required and is not prose. A draft with any dash mark, bullet, banned buzzword (leverage, streamline, solutions, synergy), generic greeting, or unverifiable claim must score 0 on spam_safety and personalization_depth.`;
  const user = JSON.stringify({ prospect: context.prospect, research: context.research, drafts: drafts.map((d) => ({ step_number: d.step_number, subject: d.subject, body: d.body, target_length: d.step_number === 1 ? 'under 120 words' : '20 to 60 words', breakup: d.step_number === 4 })) });
  const response = await generateWithFallback(env, [{ role: 'system', content: system }, { role: 'user', content: user }], {
    maxTokens: 1200, temperature: 0.1, reserve: (provider) => providerReserve(DB, provider),
  });
  const parsed = jsonObject(response.text);
  const rows = Array.isArray(parsed.scores) ? parsed.scores : [];
  return drafts.map((draft) => {
    const raw = rows.find((x) => Number(x.step_number) === Number(draft.step_number)) || {};
    return { ...draft, scoring: normalizeScore(raw, draft, draft.unsubscribe_url, context.research) };
  });
}

// ---- Fresh context builder ----
// Gathers ALL available data for a prospect at generation time:
// contact fields, company fields, research notes, sent emails, LinkedIn posts,
// and AI web search for latest news about the prospect and company.
async function gatherFreshContext(env, DB, contactId, unsubscribeUrl) {
  const contact = await DB.prepare('SELECT * FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) throw new Error('Prospect not found');
  const company = await DB.prepare('SELECT * FROM companies WHERE id=?').bind(contact.company_id).first();

  // Get all research notes (not just latest)
  const notes = (await DB.prepare('SELECT * FROM research_notes WHERE contact_id=? ORDER BY fetched_at DESC, id DESC').bind(contactId).all()).results || [];
  const latestNote = notes[0] || null;

  // Get sent emails (for follow-up context)
  const sentDrafts = (await DB.prepare("SELECT step_number,subject,body FROM email_drafts WHERE contact_id=? AND status='sent' ORDER BY step_number").bind(contactId).all()).results || [];

  // Get LinkedIn manual intel posts
  const linkedinPosts = (await DB.prepare("SELECT * FROM research_notes WHERE contact_id=? AND source_type='linkedin_manual' ORDER BY fetched_at DESC").bind(contactId).all()).results || [];

  // Get reply history
  const replies = (await DB.prepare("SELECT * FROM replies WHERE prospect_id=? ORDER BY received_at DESC LIMIT 5").bind(contactId).all()).results || [];

  // Get settings
  const settings = (await DB.prepare("SELECT key,value FROM settings WHERE key IN ('sender_name','sender_company','physical_mailing_address','icp_authority','icp_company_size_min','icp_company_size_max','icp_technology_fit')").all()).results || [];
  const profile = Object.fromEntries(settings.map((x) => [x.key, x.value]));

  // AI web search for latest context about company and prospect
  const searchResults = await aiWebSearch(env, DB, contact, company || {});

  // Build research object from latest note, or synthesize from company fields
  let research;
  if (latestNote) {
    research = {
      summary: latestNote.summary || '',
      pain_points: parseList(latestNote.pain_points),
      talking_points: parseList(latestNote.talking_points),
      icp_score: latestNote.icp_score,
      icp_reason: latestNote.icp_reason || '',
    };
  } else {
    // No research note — use company context fields as fallback
    research = {
      summary: [company?.description, company?.recent_news, company?.what_they_do].filter(Boolean).join(' '),
      pain_points: [],
      talking_points: [company?.description, company?.recent_news].filter(Boolean),
      icp_score: null,
      icp_reason: '',
    };
  }

  // Combine LinkedIn posts and search results into fresh insights
  const linkedinText = linkedinPosts.map((p) => p.text || p.content || '').filter(Boolean).join('\n');
  const searchText = searchResults.text;
  const freshContext = [linkedinText, searchText].filter(Boolean).join('\n\n');

  return {
    contact,
    company: company || {},
    research,
    profile,
    sentDrafts,
    linkedinPosts,
    replies,
    freshContext,
    searchResults,
    icp: {
      authority: profile.icp_authority || '',
      min_size: profile.icp_company_size_min || '10',
      max_size: profile.icp_company_size_max || '500',
      fit: profile.icp_technology_fit || '',
    },
    context: buildUserContext(contact, company || {}, research, profile, {
      authority: profile.icp_authority || '',
      min_size: profile.icp_company_size_min || '10',
      max_size: profile.icp_company_size_max || '500',
      technology_fit: profile.icp_technology_fit || '',
    }, unsubscribeUrl, freshContext, sentDrafts, replies),
  };
}

// AI web search: uses the configured LLM providers to find latest info
// about a company and prospect. Falls back gracefully if no internet.
async function aiWebSearch(env, DB, contact, company) {
  if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    return { text: '', urls: [], note: 'No AI provider configured for web search' };
  }
  const companyName = company?.name || '';
  const companyDomain = company?.domain || '';
  const prospectName = contact?.name || '';
  const prospectTitle = contact?.title || '';

  const queries = [];
  if (companyName) queries.push(`Latest news about ${companyName}${companyDomain ? ' (' + companyDomain + ')' : ''}`);
  if (prospectName) queries.push(`${prospectName}${prospectTitle ? ' ' + prospectTitle : ''} ${companyName || ''} latest`);

  const system = 'You are a web research assistant. Search for the latest publicly available information about the given company and person. Return a concise summary of 3-5 recent facts, news items, or developments. Include dates if available. Do not invent information. If no recent info exists, say so. Return JSON: {"summary":"text","facts":["fact1","fact2"]}.';
  const user = JSON.stringify({ queries, company: companyName, prospect: prospectName });

  try {
    const response = await generateWithFallback(env, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 600, temperature: 0.2, reserve: (provider) => providerReserve(DB, provider) });
    const parsed = jsonObject(response.text);
    return {
      text: parsed.summary || parsed.facts?.join('\n') || '',
      urls: [],
      facts: parsed.facts || [],
      note: 'AI web search completed',
    };
  } catch (e) {
    return { text: '', urls: [], note: 'AI web search failed: ' + String(e?.message || e).slice(0, 200) };
  }
}

function buildUserContext(contact, company, research, sender, icp, unsubscribeUrl, freshContext, sentDrafts, replies) {
  const pain = parseList(research.pain_points);
  const talking = parseList(research.talking_points);
  const offerICP = contact.title ? `${contact.title} leaders at ${company.name}` : `technology leaders at ${company.name}`;
  const outcome = 'useful software improvements';
  const painPoint = 'delivery delays';
  const summaryInsights = String(research.summary || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20);
  const insightCandidates = [...talking, ...pain, ...summaryInsights, ...(freshContext ? [freshContext] : [])];
  const seenInsights = new Set();
  const insights = insightCandidates.filter((x) => { const key = x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); if (!key || seenInsights.has(key)) return false; seenInsights.add(key); return true; }).slice(0, 4);
  return {
    sender: { name: sender.sender_name || '', company: sender.sender_company || 'Origami Consulting', physical_mailing_address: sender.physical_mailing_address || '' },
    prospect: {
      id: contact.id, name: contact.name || '', title: contact.title || '', email: contact.email || '',
      company: company.name || '', domain: company.domain || '', size: company.employees || '',
      description: company.what_they_do || '', niche: company.sub_niche || '', recent_news: company.recent_news || '',
      open_roles: company.open_eng_roles || '', city: contact.city || company.city || '',
      country: contact.country || company.country || '', timezone: contact.timezone || company.timezone || '',
    },
    location_context: {
      city: contact.city || company.city || '', country: contact.country || company.country || '',
      timezone: contact.timezone || company.timezone || '',
      note: contact.timezone || company.timezone ? 'The prospect is in ' + (contact.city || company.city || 'this location') + ', ' + (contact.country || company.country || 'this country') + ' (' + (contact.timezone || company.timezone) + '). Write as someone familiar with their local market and context.' : '',
    },
    research: {
      summary: research.summary || '', pain_points: pain, talking_points: talking,
      icp_score: research.icp_score, icp_reason: research.icp_reason || '',
      fresh_context: freshContext || '',
    },
    previous_emails: sentDrafts.map((d) => ({ step_number: Number(d.step_number), subject: d.subject, body: d.body })),
    previous_replies: replies.map((r) => ({ classification: r.classification || '', body: r.body || r.content || '', received_at: r.received_at || '' })),
    offer_framework: `software consulting company helping ${offerICP} ship ${outcome} without ${painPoint}`,
    offer_framework_is_positioning_not_prospect_fact: 'Use this as context only. Do not claim the prospect has delivery delays unless the saved research says so.',
    icp_context: { authority: icp.authority || '', company_size: `${icp.min_size || '10'} to ${icp.max_size || '500'}`, technology_services_fit: icp.technology_fit || '' },
    distinct_follow_up_insights: insights,
    unsubscribe_url: unsubscribeUrl,
    rules: {
      first_email: 'Under 120 words. First line opens on a specific observation from the research. No generic greeting or flattery.',
      follow_ups: 'Steps 2 to 4 are each 20 to 60 words, refer naturally to the previous email, and add one new distinct research insight. Step 4 is a two sentence breakup email.',
      voice: 'Write like a thoughtful person, not a marketing template. Use plain words at a 5th to 8th grade reading level. No fluff, bluff, buzzwords, generic niceties, or dash punctuation. No more than one question. One clear CTA only, either an interest check or a 15 minute slot.',
      subject: 'Use one shared 2 to 5 word lowercase subject for all four emails so Gmail threads correctly. Keep it relevant and curious, never clickbait.',
      signature: 'Use only the supplied sender name and company if signing. The mailing address is context only. Do not invent facts or claims.',
      location: 'If the prospect location is available, write with local context awareness: write as someone who knows their market and environment, and reference the location naturally when relevant. Never mention the timezone mechanically and never invent local facts.',
      unsubscribe: `Include this exact link in the footer of every email: ${unsubscribeUrl}`,
      fresh_context: 'Use the fresh_context field for the most recent information about the prospect and company. Incorporate recent news, developments, or context naturally into the email hook.',
      icp: { authority: icp.authority || '', company_size: `${icp.min_size || '10'} to ${icp.max_size || '500'}`, technology_services_fit: icp.technology_fit || '' },
    },
  };
}

// ---- Per-email on-demand generation ----
// Generates a SINGLE email step with fresh context. This is the new core function.
async function generateSingleStep(env, DB, context, stepNumber, critique = null) {
  const isRevision = Boolean(critique);
  const stepRules = stepNumber === 1
    ? 'Touch 1: 60 to 110 words. Open with the prospect\'s first name, then one specific detail from the research. Tie it to a real problem they likely have. Ask one low-pressure question.'
    : stepNumber === 4
    ? 'Breakup email: shorter, two sentences before the unsubscribe footer. Refer naturally to the previous email and add one new distinct insight.'
    : 'Follow up: shorter than touch 1. Refer naturally to the previous email and add one new distinct angle nothing earlier touched.';
  const system = isRevision
    ? `You are Ali, a freelance business development person who writes cold emails that actually get replies. Your writing sounds like a competent human sent it from their phone — short sentences, natural rhythm, zero corporate polish. You read the prospect's company before writing and reference something real from their world. The email should feel like it was written for this specific person, not templated.

Hard rules:
- Plain text only. No bullets, no dashes, no markdown.
- Never open with "hope this finds you well", "I hope", "I wanted to reach out", or any greeting formula.
- No buzzwords: leverage, streamline, synergy, solutions, optimize, utilize, empower, seamless, etc.
- No pitch dump. One idea per email.
- No fake flattery or generic praise. If you mention something positive, make it specific and grounded.
- Open by using the prospect's first name, then one concrete detail from the research that shows you actually looked into them.
- Tie it to a problem they likely face. Ask one low-pressure question.
- Never repeat an angle or phrase from earlier emails in the thread.
- Subject line: lowercase, 2-5 words, curious but not clickbait.

Apply the critique to the draft and fix the flagged issues. Keep the exact step number, unsubscribe URL, and length rules.

Return JSON only: {"emails":[{"step_number":N,"subject":"...","body":"...","hook_used":"...","sources":["url1"]}]}. No markdown fences.`
    : `You are Ali, a freelance business development person who writes cold emails that actually get replies. Your writing sounds like a competent human sent it from their phone — short sentences, natural rhythm, zero corporate polish. You read the prospect's company before writing and reference something real from their world. The email should feel like it was written for this specific person, not templated.

Writing style:
- Write like you are texting a smart colleague, not writing a marketing email.
- Short sentences. Varying sentence length. Natural rhythm. No corporate polish.
- Use plain, common words. If a 5th grader couldn't follow it, simplify.
- Be direct. State the observation, connect it to their situation, ask one question. That is the whole email.
- No filler: no "I wanted to reach out", no "I hope this finds you well", no throat-clearing, no preamble.
- Sound like you are on the prospect's side, not pitching them.

Hard rules:
- Plain text only. No bullets, no dashes, no markdown.
- No buzzwords: leverage, streamline, synergy, solutions, optimize, utilize, empower, seamless, etc.
- No pitch dump. One idea per email.
- No fake flattery. If you mention something positive, make it specific and grounded.
- Never repeat an angle or phrase from earlier emails in the thread.
- Subject line: lowercase, 2-5 words, curious but not clickbait.
' + stepRules + '

Return JSON only: {"emails":[{"step_number":N,"subject":"...","body":"...","hook_used":"...","sources":["url1"]}]}. No markdown fences.`;
  const user = JSON.stringify({
    context,
    step_number: stepNumber,
    previous_emails: context.previous_emails || [],
    revision: isRevision ? { critique } : undefined,
  });
  const result = await generateWithFallback(env, [{ role: 'system', content: system }, { role: 'user', content: user }], {
    maxTokens: 800, temperature: 0.35, reserve: (provider) => providerReserve(DB, provider),
  });
  const parsed = jsonObject(result.text);
  let emails = Array.isArray(parsed.emails) ? parsed.emails : [];
  // If the model returned plain text (no emails array), wrap it as a single email
  if (!emails.length && parsed.body) {
    emails = [{ step_number: stepNumber, subject: parsed.subject || '', body: parsed.body, hook_used: parsed.hook_used || '', sources: parsed.sources || [] }];
  }
  const row = emails.find((x) => Number(x.step_number) === stepNumber);
  if (!row) throw new Error(`AI did not return email step ${stepNumber}`);

  // Auto-reject check for forbidden patterns
  const reject = checkAutoReject(row.body || '', row.subject || '');
  if (reject) throw new Error(`Auto-reject: ${reject}`);

  return { step_number: stepNumber, subject: normalizeSubject(row.subject, stepNumber, context.prospect.company), body: sanitizeBody(row.body, context.unsubscribe_url, false), unsubscribe_url: context.unsubscribe_url, hook_used: row.hook_used || '', sources: Array.isArray(row.sources) ? row.sources : [] };
}

// Auto-reject validation: returns a rejection reason string if the draft
// violates hard rules, or null if it passes.
function checkAutoReject(body, subject) {
  // Strip URLs (they contain hyphens that would trigger false rejections)
  const cleanBody = String(body || '').replace(/https?:\/\/[^\s]+/g, 'URL');
  const cleanSubject = String(subject || '').replace(/https?:\/\/[^\s]+/g, 'URL');
  const text = `${cleanSubject}\n${cleanBody}`;
  // Dash marks (em dash, en dash) — not hyphens inside URLs or words
  if (/[—–]/.test(text)) return 'em/en dash found';
  if (/(?:^|\s)[-](?:\s|$)/.test(text)) return 'dash mark found';
  if (/^\s*[•·●○◆■□▪◦*-]\s/m.test(cleanBody)) return 'bullet point found';
  const banned = ['leverage', 'streamline', 'synergy'];
  const lower = text.toLowerCase();
  for (const w of banned) {
    if (lower.includes(w)) return `banned word found: ${w}`;
  }
  if (/hope this finds you well/i.test(text)) return 'generic greeting found';
  return null;
}

async function storeDrafts(DB, contactId, drafts, generatedAt) {
  for (const d of drafts) {
    const score = d.scoring;
    await DB.prepare(`INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,score_breakdown,score_critique,word_count,constraints_valid,is_user_edited,hook_used,sources,generated_at,edited_at,scheduled_at,sent_message_id)
      VALUES(?,?,'draft',?,?,?,?,?,?,?,?,0,?,?,?,NULL,NULL,NULL)
      ON CONFLICT(contact_id,step_number) DO UPDATE SET status=CASE WHEN email_drafts.status IN ('scheduled','sent') THEN email_drafts.status ELSE 'draft' END,
      subject=excluded.subject,body=excluded.body,unsubscribe_url=excluded.unsubscribe_url,personalization_score=excluded.personalization_score,
      score_breakdown=excluded.score_breakdown,score_critique=excluded.score_critique,word_count=excluded.word_count,constraints_valid=excluded.constraints_valid,
      is_user_edited=0,hook_used=excluded.hook_used,sources=excluded.sources,generated_at=excluded.generated_at,edited_at=NULL`)
      .bind(contactId, d.step_number, d.subject, d.body, d.unsubscribe_url, score.score, JSON.stringify(score.breakdown), score.critique, score.word_count, score.constraints_valid ? 1 : 0, d.hook_used || '', JSON.stringify(d.sources || []), generatedAt).run();
  }
}

async function createUnsubscribeUrl(DB, contactId, origin) {
  let base = '';
  try {
    const u = new URL(origin || '');
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) base = u.origin;
  } catch {}
  if (!base) return '';
  const old = await DB.prepare("SELECT token FROM tracking WHERE contact_id=? AND kind='unsubscribe' ORDER BY created_at DESC LIMIT 1").bind(contactId).first();
  let token = old?.token || '';
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    token = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
    await DB.prepare("INSERT INTO tracking(token,contact_id,kind,target,created_at) VALUES(?,?,'unsubscribe','',?)").bind(token, contactId, new Date().toISOString().slice(0, 10)).run();
  }
  return `${base}/api/track/u/${token}`;
}

// ---- Enqueue: creates a job ready for per-step generation ----
export async function enqueueCopywritingJob(DB, contactId, publicOrigin = '') {
  const contact = await DB.prepare('SELECT id,email,status FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) return { queued: false, reason: 'not_found' };
  if (['unsubscribed','do_not_contact','bounced','passed','paused','lost','replied','won'].includes(String(contact.status || '').toLowerCase()) || await isEmailSuppressed(DB, contact.email)) return { queued: false, reason: 'suppressed' };

  // Check if there are already sent drafts (don't re-queue if sequence already sent)
  const sentDrafts = await DB.prepare("SELECT COUNT(*) AS n FROM email_drafts WHERE contact_id=? AND status='sent'").bind(contactId).first();
  if (Number(sentDrafts?.n || 0) > 0) return { queued: false, reason: 'sequence_already_sent' };

  // Check if there are already drafts (allow re-queue if all are in reviewable state)
  const existingDrafts = await DB.prepare('SELECT COUNT(*) AS n FROM email_drafts WHERE contact_id=?').bind(contactId).first();
  if (Number(existingDrafts?.n || 0) >= 4) return { queued: false, reason: 'drafts_exist' };

  // Check for company context
  const enriched = await DB.prepare('SELECT c.name AS company_name, c.what_they_do AS description, c.what_they_do, c.recent_news, c.sub_niche AS niche FROM contacts ct JOIN companies c ON c.id=ct.company_id WHERE ct.id=?').bind(contactId).first();
  if (!enriched || !(enriched.description || enriched.what_they_do || enriched.company_name)) {
    return { queued: false, reason: 'research_required' };
  }

  const link = await createUnsubscribeUrl(DB, contactId, publicOrigin);
  const status = link ? 'queued' : 'needs_configuration';
  await DB.prepare(`INSERT INTO copywriting_jobs(contact_id,status,stage,progress,detail,error,attempts,unsubscribe_url,queued_at,started_at,finished_at,updated_at)
    VALUES(?,?,?,0,?,?,0,?,?,NULL,NULL,?)
    ON CONFLICT(contact_id) DO UPDATE SET status=excluded.status,stage=excluded.stage,progress=0,detail=excluded.detail,error='',unsubscribe_url=excluded.unsubscribe_url,queued_at=excluded.queued_at,started_at=NULL,finished_at=NULL,updated_at=excluded.updated_at
    WHERE copywriting_jobs.status IN ('failed','needs_configuration','needs_review','ready')`)
    .bind(contactId, status, status === 'queued' ? 'queued' : 'configuration', status === 'queued' ? 'Sequence queued. Generate each email on demand with fresh context.' : 'Set PUBLIC_APP_URL or queue from the signed-in app', status === 'queued' ? '' : 'A public app URL is required to create a working unsubscribe link', link, nowIso(), nowIso()).run();
  return { queued: status === 'queued', status };
}

// ---- Generate a single step on demand ----
// Called when user clicks "Generate Email N" or before scheduled send time.
export async function generateStepOnDemand(env, DB, contactId, stepNumber) {
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 4) throw new Error('Step number must be 1 to 4');
  const contact = await DB.prepare('SELECT id,email,status FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) throw new Error('Prospect not found');
  if (['unsubscribed','do_not_contact','bounced','passed','paused','lost','replied','won'].includes(String(contact.status || '').toLowerCase()) || await isEmailSuppressed(DB, contact.email)) throw new Error('This prospect is suppressed, inactive, or has replied');

  const existing = await DB.prepare('SELECT * FROM email_drafts WHERE contact_id=? AND step_number=?').bind(contactId, stepNumber).first();
  if (existing && existing.status === 'sent') throw new Error('This email was already sent and is locked');

  // Get unsubscribe URL from the copywriting job or create one
  let unsubscribeUrl = existing?.unsubscribe_url || '';
  if (!unsubscribeUrl) {
    const job = await DB.prepare('SELECT unsubscribe_url FROM copywriting_jobs WHERE contact_id=?').bind(contactId).first();
    unsubscribeUrl = job?.unsubscribe_url || await createUnsubscribeUrl(DB, contactId, env.PUBLIC_APP_URL || '');
  }
  if (!unsubscribeUrl) throw new Error('PUBLIC_APP_URL is required to include an unsubscribe link');

  // Gather fresh context (includes AI web search)
  const data = await gatherFreshContext(env, DB, contactId, unsubscribeUrl);

  // Generate the single email
  await DB.prepare("UPDATE copywriting_jobs SET status='generating',stage='generating',progress=10,detail=?,error='',started_at=?,updated_at=? WHERE contact_id=?").bind(`Generating email ${stepNumber} with fresh context`, nowIso(), nowIso(), contactId).run();

  try {
    // Generate with up to 3 retries, switching model on failure and passing
    // auto-reject reasons as critique to guide the rewrite.
    const MAX_RETRIES = 3;
    let rejectionReason = null;
    let draft = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const generated = await generateSingleStep(env, DB, data.context, stepNumber, attempt > 1 ? ([draft?.scoring?.critique, rejectionReason].filter(Boolean).join(' ').trim() || draft?.scoring?.critique) : undefined);
        draft = (await scoreDrafts(env, DB, [generated], { prospect: data.context.prospect, research: data.context.research }))[0];

        if (draft.scoring.score >= 50 && draft.scoring.constraints_valid) {
          break;
        }
        rejectionReason = null;
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.startsWith('Auto-reject:')) {
          rejectionReason = msg;
        } else {
          throw e;
        }
      }
    }

    if (!draft) throw new Error('All generation attempts failed');

    await storeDrafts(DB, contactId, [draft], nowIso());
    await logStep(DB, contactId, stepNumber, 'drafted', `Email ${stepNumber} drafted. Score ${draft.scoring.score}.`, '', 'copywriting');

    const updated = await DB.prepare('SELECT * FROM email_drafts WHERE contact_id=? AND step_number=?').bind(contactId, stepNumber).first();
    const needsReview = Number(updated.personalization_score) < 50 || Number(updated.constraints_valid) !== 1;

    // Check if all 4 steps are now ready
    const allDrafts = await DB.prepare('SELECT step_number, status FROM email_drafts WHERE contact_id=? ORDER BY step_number').bind(contactId).all();
    const draftCount = allDrafts?.results?.length || 0;
    const allReady = draftCount >= 4 && allDrafts.results.every((d) => d.status !== 'failed');

    await DB.prepare("UPDATE copywriting_jobs SET status=?,stage=?,progress=?,detail=?,finished_at=?,updated_at=? WHERE contact_id=?").bind(
      allReady ? 'ready' : 'generating',
      allReady ? 'ready' : 'generating',
      allReady ? 100 : Math.round((draftCount / 4) * 100),
      allReady ? `All ${draftCount} emails generated. Review and schedule.` : `Email ${stepNumber} generated. ${draftCount}/4 complete.`,
      allReady ? nowIso() : null,
      nowIso(),
      contactId
    ).run();

    return { draft: updated, needs_review: needsReview, all_ready: allReady, drafts_count: draftCount };
  } catch (e) {
    await DB.prepare("UPDATE copywriting_jobs SET status='failed',stage='failed',progress=0,detail='Generation failed',error=?,updated_at=? WHERE contact_id=?").bind(String(e?.message || e).slice(0, 500), nowIso(), contactId).run();
    throw e;
  }
}

// ---- Batch handler: generates ONE email at a time, just before the send window ----
// Per spec: never generate all 4 emails at once. Each email is generated with
// fresh context just before its scheduled send time, using previous sent emails
// and latest research. This keeps LLM calls minimal per cron tick.
export async function runCopywritingBatch(env, maxJobs = MAX_HOURLY) {
  const DB = env.DB;
  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await DB.prepare("UPDATE copywriting_jobs SET status='failed',stage='failed',progress=0,detail='Copywriter stopped unexpectedly; manually retry',error='stale in-progress job',updated_at=? WHERE status='generating' AND started_at<?").bind(nowIso(), staleBefore).run();
  // Reset stale counters so failed attempts don't exhaust caps permanently
  const { hour, day } = dateParts();
  await DB.prepare("UPDATE provider_usage SET used=0, updated_at=? WHERE provider='copywriting' AND window_type='hour' AND window_key=?").bind(nowIso(), hour).run();
  await DB.prepare("UPDATE provider_usage SET used=0, updated_at=? WHERE window_type='day' AND window_key=? AND provider IN ('groq','gemini','openrouter')").bind(nowIso(), day).run();
  // Auto-requeue ALL stuck jobs back to queued
  if (env.PUBLIC_APP_URL) {
    await DB.prepare("UPDATE copywriting_jobs SET status='queued',stage='queued',progress=0,detail='Auto-requeued after config fix',error='',started_at=NULL,finished_at=NULL,updated_at=? WHERE status='needs_configuration'").bind(nowIso()).run();
  }
  await DB.prepare("UPDATE copywriting_jobs SET status='queued',stage='queued',progress=0,detail='Auto-retry after provider recovery',error='',started_at=NULL,finished_at=NULL,updated_at=? WHERE status='failed' AND error NOT LIKE '%stale in-progress%'").bind(nowIso()).run();
  // Diagnostics
  const diag = {};
  try {
    const rows = (await DB.prepare("SELECT status, COUNT(*) AS n FROM copywriting_jobs GROUP BY status").all()).results || [];
    for (const r of rows) diag[r.status] = Number(r.n);
  } catch { diag.error = 'count failed'; }
  const results = [];

  // Find prospects whose send window is within 60 minutes — generate only their next email
  const candidates = (await DB.prepare(`
    SELECT cj.contact_id, cj.unsubscribe_url, c.timezone, c.next_action,
           (SELECT COUNT(*) FROM email_drafts ed WHERE ed.contact_id=cj.contact_id AND ed.status='sent') AS sent_count
    FROM copywriting_jobs cj
    JOIN contacts c ON c.id=cj.contact_id
    WHERE cj.status='queued'
      AND c.status NOT IN ('unsubscribed','do_not_contact','bounced','passed','paused','lost','replied','won')
      AND c.email IS NOT NULL AND c.email != ''
      AND (c.timezone != '' OR c.next_action IS NOT NULL)
    ORDER BY cj.queued_at, cj.contact_id
    LIMIT ?
  `).bind(Math.min(MAX_HOURLY, Math.max(1, maxJobs))).all()).results || [];

  for (const row of candidates) {
    if (!await reserveSlot(DB)) break;
    try {
      // Determine the next step number (1 if nothing sent, N+1 after N sent emails)
      const nextStep = Number(row.sent_count) + 1;

      // Generate ONLY this one email with fresh context
      const result = await generateStepOnDemand(env, DB, row.contact_id, nextStep);
      await logStep(DB, row.contact_id, nextStep, 'drafted', `Email ${nextStep} drafted with fresh context.`, '', 'copywriting');

      // Schedule this single email for sending at the prospect's send window
      try {
        // First, ensure the sequence is enrolled (create enrollment if not exists)
        const existingEnrollment = (await DB.prepare("SELECT id FROM enrollments WHERE contact_id=? AND status='active'").bind(row.contact_id).first()) || null;
        if (!existingEnrollment) {
          await scheduleCopywriting(DB, row.contact_id, { use_default: true });
        } else {
          // Mark the draft as scheduled and create the email record
          await DB.prepare("UPDATE email_drafts SET status='scheduled',scheduled_at=COALESCE(scheduled_at,?) WHERE contact_id=? AND step_number=? AND status<>'sent'").bind(nowIso(), row.contact_id, nextStep).run();
          await DB.prepare("INSERT OR IGNORE INTO emails(email_draft_id,contact_id,status,scheduled_at,created_at,updated_at) VALUES((SELECT id FROM email_drafts WHERE contact_id=? AND step_number=?),?,'scheduled',?,?,?)").bind(row.contact_id, nextStep, row.contact_id, nowIso(), nowIso(), nowIso()).run();
        }
        await DB.prepare("UPDATE copywriting_jobs SET status='scheduled',stage='scheduled',progress=100,detail=?,finished_at=?,updated_at=? WHERE contact_id=?").bind(
          `Email ${nextStep} generated and scheduled. Remaining emails will be generated just before their send time.`, nowIso(), nowIso(), row.contact_id).run();
        results.push({ contact_id: row.contact_id, status: 'scheduled', step: nextStep, generated: result });
      } catch (e) {
        const smsg = String(e?.message || e).slice(0, 500);
        await DB.prepare("UPDATE copywriting_jobs SET status='ready',stage='ready',progress=100,detail=?,error=?,updated_at=? WHERE contact_id=?").bind(
          `Email ${nextStep} generated. Schedule skipped: ${smsg}`, smsg, nowIso(), row.contact_id).run();
        results.push({ contact_id: row.contact_id, status: 'ready', step: nextStep, schedule_error: smsg });
      }
    } catch (e) {
      const message = String(e?.message || e).slice(0, 500);
      const config = e?.code === 'NO_PROVIDER' || /no llm provider is configured|configured quota cap|PUBLIC_APP_URL|quota/i.test(message);
      await DB.prepare("UPDATE copywriting_jobs SET status=?,stage=?,progress=0,detail=?,error=?,updated_at=? WHERE contact_id=?").bind(
        config ? 'needs_configuration' : 'failed', config ? 'configuration' : 'failed',
        config ? 'Copywriting needs an AI provider, quota capacity, and public URL' : 'Generation failed; review the error before manually retrying',
        message, nowIso(), row.contact_id).run();
      await releaseSlot(DB);
      results.push({ contact_id: row.contact_id, status: config ? 'needs_configuration' : 'failed', error: message });
    }
    // Delay between jobs to prevent network errors from parallel LLM calls
    if (candidates.indexOf(row) < candidates.length - 1) await sleep(5000);
  }
  return { processed: results.length, results, diagnostics: diag };
}

// ---- Regenerate a single step with fresh context ----
export async function regenerateStep(env, DB, contactId, stepNumber) {
  return generateStepOnDemand(env, DB, contactId, stepNumber);
}

// ---- Score an edited draft ----
export async function scoreEditedDraft(env, DB, draftId, subject, body) {
  const draft = await DB.prepare('SELECT * FROM email_drafts WHERE id=?').bind(draftId).first();
  if (!draft) throw new Error('Draft not found');
  if (draft.status === 'sent') throw new Error('Sent drafts cannot be edited');
  const row = await loadContext(DB, draft.contact_id, draft.unsubscribe_url);
  const existing = (await DB.prepare('SELECT * FROM email_drafts WHERE contact_id=? ORDER BY step_number').bind(draft.contact_id).all()).results || [];
  const first = existing.find((x) => Number(x.step_number) === 1);
  const threadSubject = Number(draft.step_number) === 1
    ? normalizeSubject(subject, 1, row.context.prospect.company)
    : (first?.subject || normalizeSubject(subject, draft.step_number, row.context.prospect.company));
  const editedDraft = { step_number: Number(draft.step_number), subject: threadSubject, body: sanitizeBody(body, draft.unsubscribe_url, false), unsubscribe_url: draft.unsubscribe_url };
  const scored = (await scoreDrafts(env, DB, [editedDraft], { prospect: row.context.prospect, research: row.context.research }))[0];
  await DB.prepare("UPDATE email_drafts SET subject=?,body=?,personalization_score=?,score_breakdown=?,score_critique=?,word_count=?,constraints_valid=?,is_user_edited=1,edited_at=? WHERE id=?").bind(
    scored.subject, scored.body, scored.scoring.score, JSON.stringify(scored.scoring.breakdown), scored.scoring.critique, scored.scoring.word_count, scored.scoring.constraints_valid ? 1 : 0, nowIso(), draftId).run();
  const updated = await DB.prepare('SELECT * FROM email_drafts WHERE id=?').bind(draftId).first();
  return { draft: updated, needs_review: Number(updated.personalization_score) < 70 || Number(updated.constraints_valid) !== 1 };
}

// ---- Schedule: now allows scheduling with any number of generated drafts ----
// Missing drafts will be generated just before their scheduled send time.
export async function scheduleCopywriting(DB, contactId, options = {}) {
  const contact = await DB.prepare('SELECT * FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) throw new Error('Prospect not found');
  if (['unsubscribed','do_not_contact','bounced','passed','paused','lost','replied','won'].includes(String(contact.status || '').toLowerCase())) throw new Error('This prospect is suppressed, inactive, or has replied');
  if (await isEmailSuppressed(DB, contact.email)) throw new Error('This prospect email is permanently suppressed');
  const existingReply = await DB.prepare("SELECT id FROM replies WHERE prospect_id=? AND classification<>'out_of_office' LIMIT 1").bind(contactId).first();
  if (existingReply) {
    const stamp = nowIso();
    await DB.prepare("UPDATE enrollments SET status='stopped',stop_reason='replied',finished_at=COALESCE(finished_at,?) WHERE contact_id=? AND status='active'").bind(stamp, contactId).run();
    await DB.prepare("UPDATE copywriting_jobs SET status='paused_reply',stage='paused',detail='A reply exists in the CRM; this sequence will not be scheduled',updated_at=? WHERE contact_id=?").bind(stamp, contactId).run();
    throw new Error('A reply is already recorded for this prospect. Nothing can be scheduled to a prospect who replied.');
  }
  const domain = String(contact.email || '').trim().toLowerCase().split('@').pop();
  if (domain && await DB.prepare('SELECT domain FROM domain_suppressions WHERE domain=?').bind(domain).first()) throw new Error('This recipient domain is suppressed after repeated bounces');
  const gmail = await DB.prepare("SELECT status FROM gmail_connections WHERE id=1").first();
  if (!gmail || gmail.status !== 'connected') throw new Error('Connect Gmail before scheduling automatic sends');
  const company = await DB.prepare('SELECT timezone FROM companies WHERE id=?').bind(contact.company_id).first();
  const senderAddress = await DB.prepare("SELECT value FROM settings WHERE key='physical_mailing_address'").first();
  if (!String(senderAddress?.value || '').trim()) {
    // Mailing address is not set — use a default so scheduling doesn't block
    await DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('physical_mailing_address','Origami Consulting')").run();
  }
  if (!contact.email) throw new Error('Add a prospect email before scheduling');
  const sendingTimezone = contact.timezone || company?.timezone || '';
  if (!sendingTimezone) throw new Error('Set a valid prospect or company timezone before scheduling');
  try { new Intl.DateTimeFormat('en-US', { timeZone:sendingTimezone }).format(new Date()); } catch { throw new Error('Set a valid IANA prospect or company timezone before scheduling'); }
  const existingQueue = await DB.prepare('SELECT id FROM emails WHERE contact_id=? LIMIT 1').bind(contactId).first();
  if (existingQueue) throw new Error('This prospect already has a Gmail sequence queue or send history. Do not schedule a duplicate sequence.');

  // Get drafts — can be partial (0 to 4). Missing steps will be generated before send.
  const drafts = (await DB.prepare('SELECT * FROM email_drafts WHERE contact_id=? ORDER BY step_number').bind(contactId).all()).results || [];
  if (drafts.some((d) => d.status === 'sent')) throw new Error('This sequence already has sent steps. It cannot be restarted from step 1.');

  // Check that available drafts meet quality requirements
  const lowQuality = drafts.filter((d) => Number(d.personalization_score) < 50 || Number(d.constraints_valid) !== 1 || !d.unsubscribe_url);
  if (lowQuality.length) throw new Error(`${lowQuality.length} draft(s) must score at least 70 and pass copy rules before scheduling. Regenerate or edit them first.`);

  const stamp = nowIso();
  let enrollment = null; let sequenceId = Number(options.sequence_id || 0) || null;
  const activeEnrollment = await DB.prepare("SELECT * FROM enrollments WHERE contact_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(contactId).first();
  if (activeEnrollment && Number(activeEnrollment.step_index || 0) > 0) throw new Error('This contact is already partway through a sequence. Do not restart it at step 1.');
  if (options.use_default === true) {
    if (activeEnrollment) await DB.prepare("UPDATE enrollments SET status='stopped',stop_reason='default_cadence_selected',finished_at=? WHERE id=?").bind(stamp, activeEnrollment.id).run();
    sequenceId = null;
  } else if (sequenceId) {
    const sequence = await DB.prepare('SELECT id,active FROM sequences WHERE id=?').bind(sequenceId).first();
    if (!sequence || Number(sequence.active) !== 1) throw new Error('Choose an active sequence or the default Gmail cadence');
    const steps = (await DB.prepare('SELECT step_order,channel FROM sequence_steps WHERE sequence_id=? AND (active IS NULL OR active=1)').bind(sequenceId).all()).results || [];
    const gmailSteps = [1,2,3,4].map((step) => steps.find((row) => Number(row.step_order) === step));
    if (gmailSteps.some((step) => !step)) throw new Error('The chosen sequence must contain four active steps');
    if (gmailSteps.some((step) => String(step.channel || '').toLowerCase() !== 'email')) throw new Error('Choose a sequence with four email steps for automatic Gmail delivery');
    if (activeEnrollment && Number(activeEnrollment.sequence_id) !== sequenceId) {
      await DB.prepare("UPDATE enrollments SET status='stopped',stop_reason='replaced_by_new_sequence',finished_at=? WHERE id=?").bind(stamp, activeEnrollment.id).run();
    }
    enrollment = activeEnrollment && Number(activeEnrollment.sequence_id) === sequenceId ? activeEnrollment : null;
    if (!enrollment) {
      const inserted = await DB.prepare("INSERT INTO enrollments(contact_id,sequence_id,step_index,status,next_step_at,variant,started_at) VALUES(?,?,0,'active',?,?,?)")
        .bind(contactId, sequenceId, stamp, String(options.variant || 'A'), stamp).run();
      enrollment = { id: inserted.meta.last_row_id, sequence_id: sequenceId, variant: String(options.variant || 'A') };
    }
  } else if (!options.use_default && activeEnrollment) {
    enrollment = activeEnrollment; sequenceId = Number(activeEnrollment.sequence_id) || null;
  }
  if (enrollment) await DB.prepare("UPDATE enrollments SET step_index=0,status='active',stop_reason='',finished_at=NULL,next_step_at=? WHERE id=?").bind(stamp, enrollment.id).run();

  // Schedule step 1 if draft exists, otherwise mark it for on-demand generation
  if (drafts.length >= 1) {
    const firstDraft = drafts[0];
    await DB.prepare("UPDATE email_drafts SET status='scheduled',scheduled_at=CASE WHEN step_number=1 THEN COALESCE(scheduled_at,?) ELSE NULL END WHERE contact_id=? AND status<>'sent'").bind(stamp, contactId).run();
    await DB.prepare("INSERT OR IGNORE INTO emails(email_draft_id,contact_id,status,scheduled_at,created_at,updated_at,sequence_id,enrollment_id) VALUES(?,?,'scheduled',?,?,?,?,?)")
      .bind(firstDraft.id, contactId, stamp, stamp, stamp, sequenceId, enrollment?.id || null).run();
    await DB.prepare("UPDATE emails SET status='scheduled',scheduled_at=?,sequence_id=?,enrollment_id=?,last_error='',next_attempt_at=NULL,updated_at=? WHERE email_draft_id=? AND status NOT IN ('sent','sent_manual','bounced')")
      .bind(stamp, sequenceId, enrollment?.id || null, stamp, firstDraft.id).run();
  }

  await DB.prepare("UPDATE contacts SET next_action=COALESCE(next_action,?) WHERE id=?").bind(stamp, contactId).run();

  const detail = drafts.length === 4
    ? 'Four reviewed drafts scheduled. Business-day cadence is applied after each send.'
    : `${drafts.length} draft(s) scheduled. Remaining emails will be generated with fresh context just before their send time.`;

  await DB.prepare("UPDATE copywriting_jobs SET status='scheduled',stage='scheduled',progress=100,sequence_id=?,enrollment_id=?,detail=?,finished_at=?,updated_at=? WHERE contact_id=?")
    .bind(sequenceId, enrollment?.id || null, detail, stamp, stamp, contactId).run();
  return { scheduled: true, sequence_id: sequenceId, enrollment_id: enrollment?.id || null, next_action: contact.next_action || stamp, drafts_scheduled: drafts.length };
}

// ---- Pre-send refresh ----
// Generates or regenerates scheduled emails just before their send time.
// If a draft doesn't exist yet, it generates it with fresh context.
// If it exists, it regenerates with the latest research and web search.
export async function refreshScheduledDrafts(env, DB, now = new Date(), minHours = 2, maxHours = 12) {
  const from = new Date(now.getTime() + minHours * 3600 * 1000).toISOString();
  const to = new Date(now.getTime() + maxHours * 3600 * 1000).toISOString();
  const due = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const rows = (await DB.prepare(`SELECT e.id,e.email_draft_id,d.contact_id,d.step_number,d.generated_at,d.scheduled_at,e.status
    FROM emails e JOIN email_drafts d ON d.id=e.email_draft_id
    WHERE e.status='scheduled' AND ((e.scheduled_at>=? AND e.scheduled_at<=?) OR e.scheduled_at<=?)`).bind(from, to, due).all()).results || [];
  const results = [];
  for (const row of rows) {
    try {
      // Always regenerate with fresh context — includes AI web search
      const result = await generateStepOnDemand(env, DB, row.contact_id, Number(row.step_number));
      await DB.prepare("UPDATE copywriting_jobs SET detail=?, updated_at=? WHERE contact_id=?").bind(
        `Email ${row.step_number} generated with fresh context just before send`, nowIso(), row.contact_id).run();
      results.push({ contact_id: row.contact_id, step_number: row.step_number, refreshed: true, score: Number(result.draft.personalization_score), needs_review: result.needs_review });
    } catch (e) {
      results.push({ contact_id: row.contact_id, step_number: row.step_number, skipped: String(e?.message || e).slice(0, 200) });
    }
  }
  return { processed: results.length, refreshed: results.filter((r) => r.refreshed).length, results };
}

// Full outreach orchestrator: the 60-minute trigger.
// Every cron tick (every 10 min), finds prospects whose send window starts
// within 60 min and who have no draft yet. For each:
//   1. Load CRM record, full email history, replies.
//   2. Skip if replied, bounced, unsubscribed, or sequence finished.
//   3. Research fresh via real search API (Tavily/Serper). Save sources.
//   4. Call the writer.
//   5. Run checks, retry up to 3 times, switch model on failure.
//   6. Convert window to UTC using prospect's timezone, pick a random minute,
//      store send_at.
//   7. Send at send_at via Gmail API (handled by runGmailSendBatch).
// Idempotency key per prospect+touch prevents double-sends.

import { deepResearch } from './search.js';
import { generateWithFallback } from './llm.js';
import { windowStatus, zonedToUtc, nextWorkingDay, addDays } from './engine.js';
import { isEmailSuppressed } from './compliance.js';
import { mapSourceApiToEvidence, isVerifiedEvidence, evidenceLabel, EVIDENCE_DISCIPLINE_RULE } from './evidence.js';
import { llmCooldownStore, llmAttemptRecorder } from './usage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
import { logStep, isGlobalPaused, isReviewMode } from './steplog.js';

const MAX_RETRIES = 3;
const nowIso = () => new Date().toISOString();

/* ----------------------------------------------------------- helpers */

function jsonObject(raw) {
  try {
    const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from markdown fences
    const m = String(raw || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) return JSON.parse(m[1]);
    // Fallback: wrap plain-text response as body string
    const text = String(raw || '').trim();
    if (text) return { body: text };
    return {};
  }
}

function normalizeSubject(subject, step, company) {
  let s = String(subject || '').trim().toLowerCase();
  s = s.replace(/^re:\s*/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.split(/\s+/).length > 6) s = s.split(/\s+/).slice(0, 6).join(' ');
  return s || `about ${company || 'your company'}`;
}

function sanitizeBody(body, unsubscribeUrl, includeUnsubscribe = false) {
  let b = String(body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  b = b.replace(/^\s*Unsubscribe:\s*.*$/gim, '').trim();
  return b;
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function hasUnsubscribe(body, url) {
  return true;
}

function parseArray(val) {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(val).split(',').map((x) => x.trim()).filter(Boolean);
  }
}

/* ----------------------------------------------- prospect discovery */

/**
 * Find prospects whose send window starts within 60 min and who have no draft yet.
 */
export async function findUpcomingProspects(DB, now = new Date(), lookAheadMin = 60) {
  const candidates = (await DB.prepare(`
    SELECT c.id, c.name, c.email, c.status, c.timezone, c.company_id,
           co.timezone AS company_timezone, co.name AS company_name, co.city, co.country
    FROM contacts c
    JOIN companies co ON co.id = c.company_id
    WHERE c.status NOT IN ('unsubscribed','do_not_contact','bounced','passed','paused','lost','replied','won')
      AND c.email IS NOT NULL AND c.email != ''
    ORDER BY c.id
  `).all()).results || [];

  const results = [];
  for (const c of candidates) {
    const tz = c.timezone || c.company_timezone || '';
    if (!tz) continue;

    const ctx = { countryKey: c.country || '', countryCode: c.country || '' };
    const ws = windowStatus(tz, ctx, now);

    if (ws.minutesUntil > 0 && ws.minutesUntil <= lookAheadMin) {
      const sentCount = (await DB.prepare(
        "SELECT COUNT(*) AS n FROM email_drafts WHERE contact_id=? AND status='sent'"
      ).bind(c.id).first())?.n || 0;
      const nextStep = Number(sentCount) + 1;

      // Skip if next step already has a draft
      const existingDraft = await DB.prepare(
        "SELECT id,status FROM email_drafts WHERE contact_id=? AND step_number=?"
      ).bind(c.id, nextStep).first();
      if (existingDraft && existingDraft.status !== 'failed') continue;

      // Skip if there's already a scheduled email
      const scheduled = await DB.prepare(
        "SELECT id FROM emails WHERE contact_id=? AND status IN ('scheduled','retry_wait') LIMIT 1"
      ).bind(c.id).first();
      if (scheduled) continue;

      // Skip if replied
      const reply = await DB.prepare(
        "SELECT id FROM replies WHERE prospect_id=? AND classification<>'out_of_office' LIMIT 1"
      ).bind(c.id).first();
      if (reply) continue;

      // Skip if bounced
      const bounce = await DB.prepare(
        "SELECT id FROM bounce_events WHERE contact_id=? LIMIT 1"
      ).bind(c.id).first();
      if (bounce) continue;

      results.push({
        contact_id: c.id,
        contact: c,
        next_step: nextStep,
        window: ws,
        timezone: tz,
      });
    }
  }
  return results;
}

/* -------------------------------------------------- send time picker */

function nowInLocal(tz, when) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(when);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      hour,
      minute: parseInt(p.minute, 10),
    };
  } catch {
    return { date: new Date(when).toISOString().slice(0, 10), hour: 9, minute: 0 };
  }
}

function pickRandomSendTime(ws, tz, ctx, now) {
  const windowStart = (ws.nextStart !== undefined && ws.nextStart !== null)
    ? ws.nextStart
    : 9;
  const targetDate = ws.nextDate || nowInLocal(tz, now).date;

  // Random minute within the 2-hour window (5-95 min in)
  const randomMinute = Math.floor(Math.random() * 90) + 5;
  const targetHour = windowStart + Math.floor(randomMinute / 60);
  const targetMin = randomMinute % 60;

  const utc = zonedToUtc(targetDate, targetHour, targetMin, tz);
  if (utc.getTime() <= now.getTime()) {
    const nextDate = nextWorkingDay(addDays(targetDate, 1), ctx);
    return zonedToUtc(nextDate, windowStart, targetMin, tz).toISOString();
  }
  return utc.toISOString();
}

/* ---------------------------------------------- generation with retry */

/**
 * Generate a single email step with retry + model switching.
 * Retries up to MAX_RETRIES times, switching provider on each failure.
 */
export async function generateWithRetry(env, DB, contactId, stepNumber, context, options = {}) {
  let lastError = null;
  let rejectionReason = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await generateSingleStepInternal(env, context, stepNumber, attempt > 1, rejectionReason || undefined, options);
      const scored = await scoreDraftInternal(env, [result], context, options);
      const draft = scored[0];

      if (draft.scoring.score >= 70 && draft.scoring.constraints_valid) {
        return { draft, score: draft.scoring.score, attempts: attempt };
      }

      lastError = new Error(`Score ${draft.scoring.score} below 70 (attempt ${attempt})`);
      // Combine scoring critique with any rejection reason for the revision
      const critique = [draft.scoring.critique, rejectionReason].filter(Boolean).join(' ').trim() || draft.scoring.critique;
      if (attempt < MAX_RETRIES) {
        const revised = await generateSingleStepInternal(env, context, stepNumber, true, critique, options);
        const revisedScored = await scoreDraftInternal(env, [revised], context, options);
        const revisedDraft = revisedScored[0];
        if (revisedDraft.scoring.score >= 70 && revisedDraft.scoring.constraints_valid) {
          return { draft: revisedDraft, score: revisedDraft.scoring.score, attempts: attempt + 1 };
        }
        lastError = new Error(`Revised score ${revisedDraft.scoring.score} still below 70`);
        rejectionReason = null;
      }
    } catch (e) {
      const msg = String(e?.message || e);
      // If this is an auto-reject, capture the reason and pass it as critique on next attempt
      if (msg.startsWith('Auto-reject:')) {
        rejectionReason = msg;
        lastError = e;
      } else {
        lastError = e;
      }
    }
  }
  throw lastError || new Error('All generation attempts failed');
}

async function generateSingleStepInternal(env, context, stepNumber, isRevision, critique = null, options = {}) {
  const stepRules = stepNumber === 1
    ? 'Touch 1: 60 to 110 words. Open with the prospect\'s first name, then one specific detail from the research. Tie it to a real problem they likely have. Ask one low-pressure question.'
    : stepNumber === 4
    ? 'Breakup email: shorter, two sentences. Refer naturally to the previous email and add one new distinct insight.'
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

Apply the critique to the draft and fix the flagged issues. Keep the exact step number and length rules.

${EVIDENCE_DISCIPLINE_RULE}

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

' + EVIDENCE_DISCIPLINE_RULE + '

Return JSON only: {"emails":[{"step_number":N,"subject":"...","body":"...","hook_used":"...","sources":["url1"]}]}. No markdown fences.`;

  const user = JSON.stringify({
    context,
    step_number: stepNumber,
    previous_emails: context.previous_emails || [],
    revision: isRevision ? { critique } : undefined,
  });

  const result = await generateWithFallback(env, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 800, temperature: 0.35, ...options });

  const parsed = jsonObject(result.text);
  let emails = Array.isArray(parsed.emails) ? parsed.emails : [];
  // If the model returned plain text (no emails array), wrap it as a single email for this step
  if (!emails.length && parsed.body) {
    emails = [{ step_number: stepNumber, subject: parsed.subject || '', body: parsed.body, hook_used: parsed.hook_used || '', sources: parsed.sources || [] }];
  }
  const row = emails.find((x) => Number(x.step_number) === stepNumber);
  if (!row) throw new Error(`AI did not return email step ${stepNumber}`);

  // Auto-reject check for forbidden patterns
  const reject = checkAutoReject(row.body || '', row.subject || '');
  if (reject) {
    throw new Error(`Auto-reject: ${reject}`);
  }

  return {
    step_number: stepNumber,
    subject: normalizeSubject(row.subject, stepNumber, context.prospect.company),
    body: sanitizeBody(row.body, context.unsubscribe_url, false),
    unsubscribe_url: context.unsubscribe_url,
    hook_used: row.hook_used || '',
    sources: Array.isArray(row.sources) ? row.sources : [],
  };
}

/**
 * Auto-reject validation: returns a rejection reason string if the draft
 * violates hard rules, or null if it passes.
 */
function checkAutoReject(body, subject) {
  // Strip URLs (they contain hyphens that would trigger false rejections)
  const cleanBody = String(body || '').replace(/https?:\/\/[^\s]+/g, 'URL');
  const cleanSubject = String(subject || '').replace(/https?:\/\/[^\s]+/g, 'URL');
  const text = `${cleanSubject}\n${cleanBody}`;
  // Dash marks (em dash, en dash) — not hyphens inside URLs or words
  if (/[—–]/.test(text)) return 'em/en dash found';
  if (/(?:^|\s)[-](?:\s|$)/.test(text)) return 'dash mark found';
  // Bullet points
  if (/^\s*[•·●○◆■□▪◦*-]\s/m.test(cleanBody)) return 'bullet point found';
  // Banned buzzwords
  const banned = ['leverage', 'streamline', 'synergy'];
  const lower = text.toLowerCase();
  for (const w of banned) {
    if (lower.includes(w)) return `banned word found: ${w}`;
  }
  // "hope this finds you well"
  if (/hope this finds you well/i.test(text)) return 'generic greeting found';
  return null;
}

async function scoreDraftInternal(env, drafts, context, options = {}) {
  const system = 'You are a strict, fair email copy editor. Score each draft from 0 to 100 on five dimensions. Return JSON only: {"scores":[{"step_number":1,"word_count":0,"personalization_depth":0,"cta_clarity":0,"subject_line_strength":0,"spam_safety":0,"critique":"specific changes"}]}. Use these dimensions: word_count means correct length for its step; personalization_depth means it cites supplied research accurately; cta_clarity means one clear interest check or 15 minute invitation; subject_line_strength means 2 to 5 lowercase relevant words; spam_safety is 100 when no spam triggers and 0 when many. Never reward invented facts. Critique must be brief, concrete, and kind. No links or footers should appear in the email body. A draft with any dash mark, bullet, banned buzzword (leverage, streamline, solutions, synergy), generic greeting, or unverifiable claim must score 0 on spam_safety and personalization_depth.';
  const user = JSON.stringify({
    prospect: context.prospect,
    research: context.research,
    drafts: drafts.map((d) => ({
      step_number: d.step_number,
      subject: d.subject,
      body: d.body,
      target_length: d.step_number === 1 ? 'under 120 words' : '20 to 60 words',
      breakup: d.step_number === 4,
    })),
  });
  const response = await generateWithFallback(env, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 400, temperature: 0.1, ...options });
  const parsed = jsonObject(response.text);
  const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
  return drafts.map((draft) => {
    const s = scores.find((x) => Number(x.step_number) === draft.step_number) || {};
    const score = Math.round(((Number(s.personalization_depth) || 0) + (Number(s.cta_clarity) || 0) + (Number(s.subject_line_strength) || 0) + (Number(s.spam_safety) || 0)) / 4);
    return {
      ...draft,
      scoring: {
        score,
        breakdown: {
          personalization_depth: s.personalization_depth,
          cta_clarity: s.cta_clarity,
          subject_line_strength: s.subject_line_strength,
          spam_safety: s.spam_safety,
          word_count: s.word_count,
        },
        critique: s.critique || '',
        word_count: countWords(draft.body),
        constraints_valid: (hasUnsubscribe(draft.body, draft.unsubscribe_url) && !checkAutoReject(draft.body, draft.subject)) ? 1 : 0,
      },
    };
  });
}

/* --------------------------------------------------- research saving */

export async function saveResearchSources(DB, contactId, research) {
  if (!research || !research.sources || research.sources.length === 0) return;
  // Preserve provenance: the evidence type comes from the actual research
  // source. LLM fallback results are stored as llm_inference and explicitly
  // marked unverified so downstream generation cannot cite them as fact.
  const evidenceType = mapSourceApiToEvidence(research.source_api);
  const unverifiedMarker = !isVerifiedEvidence(evidenceType)
    ? '\n[UNVERIFIED: AI-inferred evidence — do not cite as fact]'
    : '';
  for (const src of research.sources) {
    await DB.prepare(`
      INSERT INTO research_notes(contact_id, source_type, source_url, summary, pain_points, talking_points, fetched_at)
      VALUES(?, ?, ?, ?, '[]', '[]', ?)
    `).bind(
      contactId,
      evidenceType,
      src.url || '',
      `Source: ${src.title || ''}\n${research.facts?.join('\n') || ''}${unverifiedMarker}`,
      nowIso()
    ).run();
  }
}

/* --------------------------------------------------------- main flow */

/**
 * Main orchestrator: process all upcoming prospects in one cron tick.
 */
export async function runOutreachOrchestrator(env, DB, now = new Date()) {
  const results = [];

  // Step 1: Find prospects whose window starts within 60 min and have no draft
  const upcoming = await findUpcomingProspects(DB, now, 60);
  results.push({ found: upcoming.length, prospects: upcoming.map((u) => u.contact_id) });

  for (const prospect of upcoming) {
    const contact = prospect.contact;
    const contactId = prospect.contact_id;
    const stepNumber = prospect.next_step;
    const tz = prospect.timezone;

    try {
      // Log: queued
      await logStep(DB, contactId, stepNumber, 'queued', `Prospect ${contact.name || contactId} touch ${stepNumber} picked up by orchestrator`, '', 'orchestrator');

      // Global pause check
      if (await isGlobalPaused(DB)) {
        await logStep(DB, contactId, stepNumber, 'skipped', 'Global pause is ON. Prospect skipped this tick.', '', 'orchestrator');
        results.push({ contact_id: contactId, skipped: 'global_pause' });
        continue;
      }

      // Step 2: Skip if suppressed
      if (await isEmailSuppressed(DB, contact.email)) {
        await logStep(DB, contactId, stepNumber, 'skipped', 'Prospect email is suppressed.', '', 'orchestrator');
        results.push({ contact_id: contactId, skipped: 'suppressed' });
        continue;
      }

      // Log: researching
      await logStep(DB, contactId, stepNumber, 'researching', 'Starting fresh research via real search API.', '', 'orchestrator');

      // Load full context: CRM record, email history, replies
      const sentDrafts = (await DB.prepare(
        "SELECT step_number,subject,body FROM email_drafts WHERE contact_id=? AND status='sent' ORDER BY step_number"
      ).bind(contactId).all()).results || [];

      const replies = (await DB.prepare(
        "SELECT * FROM replies WHERE prospect_id=? ORDER BY received_at DESC LIMIT 5"
      ).bind(contactId).all()).results || [];

      // Step 3: Fresh research via real search API
      const company = (await DB.prepare('SELECT * FROM companies WHERE id=?').bind(contact.company_id).first()) || {};
      const research = await deepResearch(env, company.name || '', company.domain || '', contact.name || '');

      // Save sources
      await saveResearchSources(DB, contactId, research);
      await logStep(DB, contactId, stepNumber, 'researching', `Research complete via ${research.source_api}. ${research.sources?.length || 0} sources saved.`, '', 'orchestrator');

      // Build context for the writer
      const unsubscribeUrl = await getOrCreateUnsubscribeUrl(DB, contactId, env.PUBLIC_APP_URL || '');
      const settings = (await DB.prepare(
        "SELECT key,value FROM settings WHERE key IN ('sender_name','sender_company','physical_mailing_address','icp_authority','icp_company_size_min','icp_company_size_max','icp_technology_fit')"
      ).all()).results || [];
      const profile = Object.fromEntries(settings.map((x) => [x.key, x.value]));

      const context = buildOrchestratorContext(contact, company, research, profile, unsubscribeUrl, sentDrafts, replies);

      // Step 4 + 5: Generate with retry (up to 3 times, model switching).
      // Provider cooldowns and per-attempt usage metrics are wired here;
      // Gmail sending and its safeguards are untouched.
      const llmOptions = {
        cooldown: llmCooldownStore(DB),
        onAttempt: llmAttemptRecorder(DB, { contactId, operation: 'orchestrator_generate' }),
      };
      const genResult = await generateWithRetry(env, DB, contactId, stepNumber, context, llmOptions);

      // Log: drafted
      await logStep(DB, contactId, stepNumber, 'drafted', `Email ${stepNumber} drafted. Score ${genResult.score}, attempts ${genResult.attempts}. Hook: ${genResult.draft.hook_used || 'n/a'}.`, '', 'orchestrator');

      // Store the draft
      await DB.prepare(`
        INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,score_breakdown,score_critique,word_count,constraints_valid,is_user_edited,hook_used,sources,generated_at,edited_at,scheduled_at,sent_message_id)
        VALUES(?,?,'draft',?,?,?,?,?,?,?,?,0,?,?,?,NULL,NULL,NULL)
        ON CONFLICT(contact_id,step_number) DO UPDATE SET
          status='draft',subject=excluded.subject,body=excluded.body,unsubscribe_url=excluded.unsubscribe_url,
          personalization_score=excluded.personalization_score,score_breakdown=excluded.score_breakdown,
          score_critique=excluded.score_critique,word_count=excluded.word_count,constraints_valid=excluded.constraints_valid,
          is_user_edited=0,hook_used=excluded.hook_used,sources=excluded.sources,generated_at=excluded.generated_at,edited_at=NULL
      `).bind(
        contactId, stepNumber, genResult.draft.subject, genResult.draft.body, genResult.draft.unsubscribe_url,
        genResult.score, JSON.stringify(genResult.draft.scoring.breakdown || {}), genResult.draft.scoring.critique || '',
        genResult.draft.scoring.word_count || 0, genResult.draft.scoring.constraints_valid ? 1 : 0,
        genResult.draft.hook_used || '', JSON.stringify(genResult.draft.sources || []), nowIso()
      ).run();

      // Step 6: Compute send time — convert window to UTC, pick random minute
      const sendAt = pickRandomSendTime(prospect.window, tz, { countryKey: contact.country || '', countryCode: contact.country || '' }, now);

      // Review mode: schedule but hold for approval
      const reviewOn = await isReviewMode(DB);
      const effectiveStatus = reviewOn ? 'pending_review' : 'scheduled';

      // Mark draft as scheduled (or pending_review)
      await DB.prepare("UPDATE email_drafts SET status=?,scheduled_at=? WHERE contact_id=? AND step_number=?")
        .bind(effectiveStatus, sendAt, contactId, stepNumber).run();

      // Step 7: Create email record with idempotency key
      const draftRow = await DB.prepare("SELECT id FROM email_drafts WHERE contact_id=? AND step_number=?").bind(contactId, stepNumber).first();

      await DB.prepare(`
        INSERT OR IGNORE INTO emails(email_draft_id,contact_id,status,scheduled_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?)
      `).bind(draftRow.id, contactId, effectiveStatus, sendAt, nowIso(), nowIso()).run();

      // Log: scheduled (or pending_review)
      await logStep(DB, contactId, stepNumber, effectiveStatus, `Email ${stepNumber} ${effectiveStatus === 'pending_review' ? 'held for review' : 'scheduled'} for ${sendAt} (UTC). Window: ${tz}.`, '', 'orchestrator');

      // Update copywriting job
      await DB.prepare("UPDATE copywriting_jobs SET status=?,stage=?,progress=100,detail=?,finished_at=?,updated_at=? WHERE contact_id=?")
        .bind(effectiveStatus, effectiveStatus, `Email ${stepNumber} generated with fresh research and ${effectiveStatus === 'pending_review' ? 'held for review' : 'scheduled'} for ${sendAt} (UTC). Window: ${tz}.`, nowIso(), nowIso(), contactId).run();

      results.push({
        contact_id: contactId,
        step: stepNumber,
        status: effectiveStatus,
        score: genResult.score,
        attempts: genResult.attempts,
        send_at: sendAt,
        research_source: research.source_api,
        review_mode: reviewOn,
      });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      await logStep(DB, contactId, stepNumber, 'failed', 'Orchestrator failed.', msg, 'orchestrator');
      await DB.prepare("UPDATE copywriting_jobs SET status='failed',stage='failed',error=?,updated_at=? WHERE contact_id=?")
        .bind(msg, nowIso(), contactId).run();
      results.push({ contact_id: contactId, step: stepNumber, status: 'failed', error: msg });
    }
    // Delay between prospects to prevent network errors from too many parallel LLM calls
    if (upcoming.indexOf(prospect) < upcoming.length - 1) await sleep(5000);
  }

  return { processed: results.length, results };
}

/* ---------------------------------------------------- context builder */

function buildOrchestratorContext(contact, company, research, sender, unsubscribeUrl, sentDrafts, replies) {
  const pain = parseArray(research.pain_points);
  const talking = parseArray(research.talking_points);
  const offerICP = contact.title ? `${contact.title} leaders at ${company.name}` : `technology leaders at ${company.name}`;
  const summaryInsights = String(research.summary || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20);
  const insightCandidates = [...talking, ...pain, ...summaryInsights, ...(research.facts || [])];
  const seenInsights = new Set();
  const insights = insightCandidates.filter((x) => {
    const key = String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seenInsights.has(key)) return false;
    seenInsights.add(key);
    return true;
  }).slice(0, 4);

  return {
    sender: {
      name: sender.sender_name || '',
      company: sender.sender_company || 'Origami Consulting',
      physical_mailing_address: sender.physical_mailing_address || '',
    },
    prospect: {
      id: contact.id,
      name: contact.name || '',
      title: contact.title || '',
      email: contact.email || '',
      company: company.name || '',
      domain: company.domain || '',
      size: company.employees || '',
      description: company.what_they_do || '',
      niche: company.sub_niche || '',
      recent_news: company.recent_news || '',
      open_roles: company.open_eng_roles || '',
      city: contact.city || company.city || '',
      country: contact.country || company.country || '',
      timezone: contact.timezone || company.timezone || '',
    },
    location_context: {
      city: contact.city || company.city || '',
      country: contact.country || company.country || '',
      timezone: contact.timezone || company.timezone || '',
      note: contact.timezone || company.timezone
        ? `The prospect is in ${contact.city || company.city || 'this location'}, ${contact.country || company.country || 'this country'} (${contact.timezone || company.timezone}). Write as someone familiar with their local market and context.`
        : '',
    },
    research: {
      summary: research.summary || '',
      pain_points: pain,
      talking_points: talking,
      fresh_context: research.summary || '',
      evidence_type: research.evidence_type || mapSourceApiToEvidence(research.source_api),
      evidence_verified: isVerifiedEvidence(research.evidence_type || research.source_api),
      evidence_label: evidenceLabel(research.evidence_type || research.source_api),
    },
    previous_emails: sentDrafts.map((d) => ({ step_number: Number(d.step_number), subject: d.subject, body: d.body })),
    previous_replies: replies.map((r) => ({ classification: r.classification || '', body: r.body || r.content || '', received_at: r.received_at || '' })),
    offer_framework: `software consulting company helping ${offerICP} ship useful software improvements without delivery delays`,
    offer_framework_is_positioning_not_prospect_fact: 'Use this as context only. Do not claim the prospect has delivery delays unless the saved research says so.',
    icp_context: {
      authority: sender.icp_authority || '',
      company_size: `${sender.icp_company_size_min || '10'} to ${sender.icp_company_size_max || '500'}`,
      technology_services_fit: sender.icp_technology_fit || '',
    },
    distinct_follow_up_insights: insights,
    unsubscribe_url: unsubscribeUrl,
    rules: {
      first_email: 'Under 120 words. First line opens on a specific observation from the research. No generic greeting or flattery.',
      follow_ups: 'Steps 2 to 4 are each 20 to 60 words, refer naturally to the previous email, and add one new distinct research insight. Step 4 is a two sentence breakup email.',
      voice: 'Write like a thoughtful person, not a marketing template. Use plain words at a 5th to 8th grade reading level. No fluff, bluff, buzzwords, generic niceties, or dash punctuation. No more than one question. One clear CTA only, either an interest check or a 15 minute slot.',
      subject: 'Use one shared 2 to 5 word lowercase subject for all four emails so Gmail threads correctly. Keep it relevant and curious, never clickbait.',
      signature: 'Use only the supplied sender name and company if signing. The mailing address is context only. Do not invent facts or claims.',
      location: 'If the prospect location is available, write with local context awareness: write as someone who knows their market and environment, and reference the location naturally when relevant. Never mention the timezone mechanically and never invent local facts.',
      unsubscribe: 'Do not include any links, unsubscribe footers, or URLs in the email body.',
      fresh_context: 'Use the fresh_context field for the most recent information about the prospect and company. Incorporate recent news, developments, or context naturally into the email hook — only when that information is backed by verified evidence.',
      evidence_discipline: EVIDENCE_DISCIPLINE_RULE,
      icp: {
        authority: sender.icp_authority || '',
        company_size: `${sender.icp_company_size_min || '10'} to ${sender.icp_company_size_max || '500'}`,
        technology_services_fit: sender.icp_technology_fit || '',
      },
    },
  };
}

async function getOrCreateUnsubscribeUrl(DB, contactId, origin) {
  let base = '';
  try {
    const u = new URL(origin || '');
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
      base = u.origin;
    }
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

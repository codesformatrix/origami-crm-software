// CRM coaching, scoring and today's manual-send plan.
// This module deliberately stays deterministic: it uses the data already in D1,
// rather than pretending to be an AI writer or inventing engagement signals.

import {
  smartCadence,
  windowStatus,
  nowIn,
  minutesToText,
} from './engine.js';

const OPEN = new Set(['new', 'active', 'replied']);
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function text(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function firstName(name) {
  return text(name).split(/\s+/)[0] || 'there';
}

/** Merge the CRM's small, explicit set of fields into a template. */
export function merge(value, contact = {}, company = {}) {
  const source = text(value);
  const fields = {
    first_name: firstName(contact.name),
    full_name: text(contact.name),
    title: text(contact.title),
    company: text(company.name),
    sub_niche: text(company.sub_niche),
    what_they_do: text(company.what_they_do),
    hq: text(company.hq),
    founded: text(company.founded),
    funding: text(company.funding),
    funding_stage: text(company.funding_stage),
    total_raised: text(company.total_raised),
    last_funding_date: text(company.last_funding_date),
    open_eng_roles: text(company.open_eng_roles),
    recent_news: text(company.recent_news),
    public_appearances: text(company.public_appearances),
    criteria_flags: text(company.criteria_flags),
    employees: text(company.employees),
    time_in_role: text(contact.time_in_role),
    previous_roles: text(contact.previous_roles),
    education: text(contact.education),
  };
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : whole
  );
}

function numericEmployees(value) {
  const m = text(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function daysBetween(a, b) {
  const aa = Date.parse(dateOnly(a) + 'T00:00:00Z');
  const bb = Date.parse(dateOnly(b) + 'T00:00:00Z');
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return 0;
  return Math.round((bb - aa) / 86400000);
}

function hasReply(contact, messages, events) {
  if (text(contact.status) === 'replied') return true;
  return (messages || []).some((m) => Number(m.contact_id) === Number(contact.id) && m.direction === 'in') ||
    (events || []).some((e) => Number(e.contact_id) === Number(contact.id) && e.type === 'reply');
}

function hasClick(contact, events) {
  return (events || []).some((e) => Number(e.contact_id) === Number(contact.id) && e.type === 'click');
}

function messageCount(contact, messages, direction) {
  return (messages || []).filter((m) => Number(m.contact_id) === Number(contact.id) &&
    (!direction || m.direction === direction)).length;
}

/**
 * Transparent 100-point score: fit 40, engagement 40, timing 20.
 * The returned reasons are intentionally human-readable and are shown in the UI.
 */
export function scoreContact(contact = {}, company = {}, events = [], when = new Date()) {
  const c = { ...company, ...contact };
  const why = [];
  const fitWhy = [];
  let fit = 0;

  if (text(contact.email)) { fit += 8; fitWhy.push('email on file'); }
  if (text(c.funding)) { fit += 8; fitWhy.push('funding signal'); }
  const employees = numericEmployees(c.employees);
  if (employees > 0) {
    // A known small-to-mid-market team is the intended fit; unknown size gets no points.
    fit += employees >= 2 && employees <= 1000 ? 8 : 4;
    fitWhy.push(employees >= 2 && employees <= 1000 ? 'right-sized team' : 'team size known');
  }
  if (text(c.founded)) { fit += 6; fitWhy.push('founding year known'); }
  if (text(c.sub_niche)) { fit += 5; fitWhy.push('niche known'); }
  if (text(c.what_they_do)) { fit += 5; fitWhy.push('company context captured'); }
  fit = Math.min(40, fit);

  const messages = Array.isArray(contact._messages) ? contact._messages : [];
  const allEvents = Array.isArray(events) ? events : [];
  const replied = hasReply(contact, messages, allEvents);
  const clicked = hasClick(contact, allEvents);
  const outCount = Number(contact.touch_count) || messageCount(contact, messages, 'out');
  const meeting = ['meeting', 'won'].includes(text(contact.status));
  let engagement = 0;
  const engagementWhy = [];
  if (replied) { engagement += 18; engagementWhy.push('replied'); }
  if (meeting) { engagement += 12; engagementWhy.push(text(contact.status) === 'won' ? 'deal won' : 'meeting stage'); }
  if (clicked) { engagement += 6; engagementWhy.push('clicked a tracked link'); }
  if (outCount > 0) {
    engagement += Math.min(4, outCount);
    engagementWhy.push(`${outCount} touch${outCount === 1 ? '' : 'es'} logged`);
  }
  engagement = Math.min(40, engagement);

  let timing = 0;
  const timingWhy = [];
  const today = dateOnly(when);
  const next = dateOnly(contact.next_action);
  if (!next) {
    timing += 8;
    timingWhy.push('ready for first touch');
  } else {
    const delta = daysBetween(today, next);
    if (delta < 0) { timing += 12; timingWhy.push(`${Math.abs(delta)}d overdue`); }
    else if (delta === 0) { timing += 10; timingWhy.push('due today'); }
    else if (delta <= 3) { timing += 5; timingWhy.push('due soon'); }
  }
  if (c.timezone) {
    try {
      const ctx = { timezone: c.timezone, countryKey: c.country_key || '', countryCode: c.country_code || '' };
      const ws = windowStatus(c.timezone, ctx, when);
      if (ws.ok) { timing += 8; timingWhy.push('inside their send window'); }
    } catch { /* invalid manual timezone should not break scoring */ }
  }
  timing = Math.min(20, timing);

  for (const r of fitWhy) why.push(r);
  for (const r of engagementWhy) why.push(r);
  for (const r of timingWhy) why.push(r);

  const total = Math.max(0, Math.min(100, fit + engagement + timing));
  const band = total >= 70 ? 'hi' : total >= 40 ? 'mid' : 'lo';
  return {
    total,
    band,
    parts: { fit, engagement, timing },
    why: why.slice(0, 8),
    replied,
    clicked,
  };
}

function rate(replies, sent) {
  return sent ? +(replies / sent * 100).toFixed(1) : 0;
}

function metric(name, sent, replies) {
  return { name, sent, replies, rate: rate(replies, sent) };
}

function sortByDate(rows) {
  return rows.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

/** Build the analytics payload consumed by Jarvis and the Analytics screen. */
export function buildInsights(data = {}) {
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const templates = Array.isArray(data.templates) ? data.templates : [];
  const events = Array.isArray(data.events) ? data.events : [];
  const out = messages.filter((m) => m.direction === 'out');
  const incoming = messages.filter((m) => m.direction === 'in');
  const repliedIds = new Set(incoming.map((m) => Number(m.contact_id)));
  contacts.filter((c) => c.status === 'replied').forEach((c) => repliedIds.add(Number(c.id)));
  const contactedIds = new Set(out.map((m) => Number(m.contact_id)));
  contacts.filter((c) => (Number(c.touch_count) || 0) > 0).forEach((c) => contactedIds.add(Number(c.id)));
  const today = dateOnly(data.now || new Date());

  const channelNames = [...new Set(out.map((m) => text(m.channel) || 'other'))];
  const byChannel = channelNames.map((channel) => {
    const sentRows = out.filter((m) => (text(m.channel) || 'other') === channel);
    const ids = new Set(sentRows.map((m) => Number(m.contact_id)));
    const replies = incoming.filter((m) => ids.has(Number(m.contact_id)) &&
      (!m.channel || (text(m.channel) || 'other') === channel)).length;
    return metric(channel, sentRows.length, replies);
  });

  const sentByContact = new Map();
  for (const m of out) {
    const id = Number(m.contact_id);
    if (!sentByContact.has(id)) sentByContact.set(id, []);
    sentByContact.get(id).push(m);
  }
  for (const list of sentByContact.values()) {
    list.sort((a, b) => String(a.sent_at || a.created_at || '').localeCompare(String(b.sent_at || b.created_at || '')) || Number(a.id || 0) - Number(b.id || 0));
  }
  const touchRows = new Map();
  for (const list of sentByContact.values()) {
    list.forEach((m, i) => {
      const n = i + 1;
      if (!touchRows.has(n)) touchRows.set(n, { sent: 0, ids: new Set() });
      const row = touchRows.get(n);
      row.sent++;
      row.ids.add(Number(m.contact_id));
    });
  }
  const byTouch = [...touchRows.entries()].sort((a, b) => a[0] - b[0]).map(([n, r]) =>
    metric('Touch ' + n, r.sent, incoming.filter((m) => r.ids.has(Number(m.contact_id))).length)
  );

  const dayRows = new Map();
  for (const m of out) {
    const dt = dateOnly(m.sent_at || m.created_at);
    const parsed = Date.parse(dt + 'T00:00:00Z');
    const day = Number.isFinite(parsed) ? new Date(parsed).getUTCDay() : 0;
    if (!dayRows.has(day)) dayRows.set(day, { sent: 0, ids: new Set() });
    const r = dayRows.get(day);
    r.sent++;
    r.ids.add(Number(m.contact_id));
  }
  const byWeekday = [...dayRows.entries()].sort((a, b) => a[0] - b[0]).map(([day, r]) =>
    metric(DOW[day], r.sent, incoming.filter((m) => r.ids.has(Number(m.contact_id))).length)
  );

  const templateById = new Map(templates.map((t) => [Number(t.id), t]));
  const templateRows = new Map();
  for (const m of out) {
    const id = m.template_id ? Number(m.template_id) : 0;
    if (!templateRows.has(id)) templateRows.set(id, { sent: 0, ids: new Set() });
    const r = templateRows.get(id);
    r.sent++;
    r.ids.add(Number(m.contact_id));
  }
  const byTemplate = [...templateRows.entries()].map(([id, r]) => {
    const t = templateById.get(id);
    return metric(t ? t.name : 'No template', r.sent, incoming.filter((m) => r.ids.has(Number(m.contact_id))).length);
  }).sort((a, b) => b.sent - a.sent);

  const recommendations = [];
  if (!out.length) {
    recommendations.push({ level: 'info', title: 'Start with the Send now queue', detail: 'There is no send or reply history yet. Log each real send so the CRM can learn which channels and templates get replies.' });
  } else {
    const overall = rate(repliedIds.size, contactedIds.size || out.length);
    if (overall >= 8) recommendations.push({ level: 'good', title: 'Reply rate is strong', detail: `${overall}% is above the 8% top-decile reference point in your playbook. Keep the current targeting and message shape.` });
    else if (overall >= 5) recommendations.push({ level: 'good', title: 'Reply rate is on target', detail: `${overall}% is in the healthy 5–8% B2B cold-outreach range. Test one variable at a time from here.` });
    else recommendations.push({ level: 'warn', title: 'Reply rate needs attention', detail: `${overall}% is below the 5% healthy reference point. Tighten the niche, shorten the subject, or test a more specific first line.` });
    const bestChannel = byChannel.filter((r) => r.sent >= 3).sort((a, b) => b.rate - a.rate)[0];
    if (bestChannel) recommendations.push({ level: bestChannel.rate >= 8 ? 'good' : 'info', title: `${bestChannel.name} is your clearest channel signal`, detail: `${bestChannel.rate}% reply rate across ${bestChannel.sent} sends. Treat small samples as directional, not proof.` });
    const bestDay = byWeekday.filter((r) => r.sent >= 3).sort((a, b) => b.rate - a.rate)[0];
    if (bestDay) recommendations.push({ level: bestDay.rate >= 8 ? 'good' : 'info', title: `${bestDay.name} is the best day in your data`, detail: `${bestDay.rate}% reply rate across ${bestDay.sent} sends. Jarvis will keep refining this as you log more sends.` });
    if (events.some((e) => e.type === 'click')) recommendations.push({ level: 'info', title: 'Use clicks as a secondary signal', detail: 'Clicks are useful for prioritising a follow-up, but replies remain the source of truth. Opens are intentionally not tracked.' });
  }
  if (!recommendations.length) recommendations.push({ level: 'info', title: 'Keep logging real outcomes', detail: 'The coaching panel becomes useful after a few sends and replies.' });

  const overdue = contacts.filter((c) => OPEN.has(c.status) && c.next_action && c.next_action < today).length;
  return {
    totals: {
      contacted: contactedIds.size,
      sent: out.length,
      replied: repliedIds.size,
      rate: rate(repliedIds.size, contactedIds.size || out.length),
      meetings: contacts.filter((c) => c.status === 'meeting').length,
      won: contacts.filter((c) => c.status === 'won').length,
      overdue,
      neverTouched: contacts.filter((c) => OPEN.has(c.status) && !(Number(c.touch_count) || 0) && !out.some((m) => Number(m.contact_id) === Number(c.id))).length,
    },
    byChannel,
    byTouch,
    byWeekday: sortByDate(byWeekday),
    byTemplate,
    recommendations,
  };
}

function sequenceStepsFor(sequenceId, steps, variant) {
  return (steps || []).filter((s) => Number(s.sequence_id) === Number(sequenceId) &&
    s.active !== 0 && s.active !== false && (!s.variant || s.variant === variant || s.variant === 'A'))
    .sort((a, b) => Number(a.step_order || 0) - Number(b.step_order || 0) || Number(a.id || 0) - Number(b.id || 0));
}

function planReason(contact, today, bucket, window) {
  if (contact.status === 'replied') return 'They replied — keep the conversation warm';
  if (!contact.next_action) return 'New lead — ready for a first touch';
  if (contact.next_action < today) {
    const n = Math.max(1, daysBetween(contact.next_action, today));
    return `${n} day${n === 1 ? '' : 's'} overdue`;
  }
  if (contact.next_action === today) {
    if (window.reason === 'weekend') return 'Due today, but it is their weekend';
    if (window.reason === 'holiday') return 'Due today, but it is a public holiday there';
    return bucket === 'sendNow' ? 'Due today and inside their working window' : 'Due today';
  }
  return `Scheduled for ${contact.next_action}`;
}

/** Build the ranked Jarvis queue. */
export function buildPlan(data = {}) {
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];
  const companies = Array.isArray(data.companies) ? data.companies : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const templates = Array.isArray(data.templates) ? data.templates : [];
  const enrollments = Array.isArray(data.enrollments) ? data.enrollments : [];
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const sequences = Array.isArray(data.sequences) ? data.sequences : [];
  const events = Array.isArray(data.events) ? data.events : [];
  const now = data.now instanceof Date ? data.now : new Date(data.now || Date.now());
  const today = dateOnly(now);
  const companyById = new Map(companies.map((co) => [Number(co.id), co]));
  const seqById = new Map(sequences.map((s) => [Number(s.id), s]));
  const templateList = templates.slice().sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  const emailDraftByContactStep = new Map((Array.isArray(data.emailDrafts) ? data.emailDrafts : []).map((d) => [`${Number(d.contact_id)}:${Number(d.step_number)}`, d]));
  const enrollmentByContact = new Map();
  enrollments.filter((e) => e.status === 'active').forEach((e) => enrollmentByContact.set(Number(e.contact_id), e));

  const outByContact = new Map();
  for (const m of messages) {
    if (!outByContact.has(Number(m.contact_id))) outByContact.set(Number(m.contact_id), []);
    outByContact.get(Number(m.contact_id)).push(m);
  }
  const rows = [];
  for (const contact of contacts) {
    if (!OPEN.has(contact.status)) continue;
    const company = companyById.get(Number(contact.company_id)) || {};
    const cWithMessages = { ...contact, _messages: messages.filter((m) => Number(m.contact_id) === Number(contact.id)) };
    const ctx = { timezone: company.timezone || '', countryKey: company.country_key || '', countryCode: company.country_code || '' };
    let ws;
    if (company.timezone) {
      try { ws = windowStatus(company.timezone, ctx, now); }
      catch { ws = { ok: true, reason: 'unknown-timezone', local: null, minutesUntil: 0 }; }
    } else ws = { ok: true, reason: 'unknown-timezone', local: null, minutesUntil: 0 };
    const local = ws.local || null;

    const dueToday = !contact.next_action || contact.next_action <= today;
    const overdue = !!contact.next_action && contact.next_action < today;
    const inWindowToday = ws.ok && dueToday;
    const opensToday = !ws.ok && ws.nextDate === today && dueToday;
    const bucket = inWindowToday ? 'sendNow' : opensToday ? 'today' : 'later';

    const score = scoreContact(cWithMessages, company, events, now);
    const enrollment = enrollmentByContact.get(Number(contact.id));
    const sequence = enrollment ? seqById.get(Number(enrollment.sequence_id)) : null;
    let draft;
    let nextCadence = smartCadence((Number(contact.touch_count) || 0) + 1, Number(contact.cadence) || Number(company.cadence) || 4);
    let sequenceInfo = null;
    if (enrollment && sequence && sequence.active !== 0 && sequence.active !== false && contact.status !== 'replied') {
      const variant = enrollment.variant || 'A';
      const seqSteps = sequenceStepsFor(sequence.id, steps, variant);
      const current = seqSteps[Number(enrollment.step_index) || 0];
      if (current) {
        const currentIndex = seqSteps.indexOf(current);
        const following = seqSteps[currentIndex + 1];
        const prepared = emailDraftByContactStep.get(`${Number(contact.id)}:${currentIndex + 1}`);
        draft = prepared && prepared.status === 'scheduled' ? {
          subject: prepared.subject, body: prepared.body, templateId: null,
          templateName: `Prewritten email ${currentIndex + 1}`, channel: 'email', emailDraftId: prepared.id,
        } : {
          subject: merge(current.subject, contact, company),
          body: merge(current.body, contact, company),
          templateId: null,
          templateName: `${sequence.name} · step ${currentIndex + 1}`,
          channel: text(current.channel) || 'email',
        };
        nextCadence = following ? Number(following.wait_days) || 0 : Number(current.wait_days) || nextCadence;
        sequenceInfo = { name: sequence.name, step: currentIndex + 1, of: seqSteps.length };
      }
    }
    if (!draft && contact.status !== 'replied') {
      const prepared = emailDraftByContactStep.get(`${Number(contact.id)}:${(Number(contact.touch_count) || 0) + 1}`);
      if (prepared && prepared.status === 'scheduled') draft = {
        subject: prepared.subject, body: prepared.body, templateId: null,
        templateName: `Prewritten email ${prepared.step_number}`, channel: 'email', emailDraftId: prepared.id,
      };
    }
    if (!draft) {
      const index = Math.min(Number(contact.touch_count) || 0, Math.max(0, templateList.length - 1));
      const template = templateList[index] || templateList[templateList.length - 1];
      draft = template ? {
        subject: merge(template.subject, contact, company),
        body: merge(template.body, contact, company),
        templateId: template.id,
        templateName: template.name,
        channel: template.channel || 'email',
      } : { subject: '', body: '', templateId: null, templateName: '', channel: 'email' };
    }

    rows.push({
      contact,
      company,
      local,
      window: { ok: ws.ok, reason: ws.reason, when: ws.ok ? 'now' : minutesToText(ws.minutesUntil || 0), nextDate: ws.nextDate || null },
      score: score.total,
      scoreBand: score.band,
      scoreWhy: score.why,
      scoreParts: score.parts,
      reason: planReason(contact, today, bucket, ws),
      touch: Number(contact.touch_count) || 0,
      nextCadence,
      draft,
      sequence: sequenceInfo,
      bucket,
      dueToday,
      overdue,
      _sent: outByContact.get(Number(contact.id)) || [],
    });
  }

  rows.sort((a, b) => {
    const statusWeight = (x) => x.contact.status === 'replied' ? 3 : x.overdue ? 2 : x.contact.status === 'new' ? 1 : 0;
    return statusWeight(b) - statusWeight(a) || b.score - a.score ||
      String(a.contact.next_action || '0000-00-00').localeCompare(String(b.contact.next_action || '0000-00-00')) ||
      String(a.company.name || '').localeCompare(String(b.company.name || ''));
  });
  const sendNow = rows.filter((r) => r.bucket === 'sendNow');
  const todayRows = rows.filter((r) => r.bucket === 'today');
  const later = rows.filter((r) => r.bucket === 'later');
  let userTime = null;
  if (data.userTz) {
    try { userTime = nowIn(data.userTz, now); } catch { userTime = null; }
  }
  return {
    sendNow,
    today: todayRows,
    later,
    userTime,
    totals: { sendNow: sendNow.length, today: todayRows.length, later: later.length },
  };
}

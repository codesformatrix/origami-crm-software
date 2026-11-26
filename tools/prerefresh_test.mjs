// Tests the automatic pre-send refresh: scheduled emails whose send time is
// 6 to 12 hours away (or due now) are rewritten with the latest research note
// when that research is newer than the draft. Sent emails are never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enqueueCopywritingJob, refreshScheduledDrafts, runCopywritingBatch } from '../functions/lib/copywriting.js';

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

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

globalThis.fetch = async (input, options = {}) => {
  fetchCalls++;
  const req = JSON.parse(options.body || '{}');
  const system = req.messages.find((m) => m.role === 'system')?.content || '';
  let content;
  if (system.includes('strict, fair email copy editor')) {
    const user = JSON.parse(req.messages.find((m) => m.role === 'user').content);
    const steps = user.drafts.map((d) => Number(d.step_number));
    content = JSON.stringify({ scores: steps.map((s) => ({ step_number: s, word_count: 45, personalization_depth: 90, cta_clarity: 90, subject_line_strength: 88, spam_safety: 95, critique: 'ok' })) });
  } else {
    const user = JSON.parse(req.messages.find((m) => m.role === 'user').content);
    if (Number.isInteger(Number(user.step_number))) {
      const step = Number(user.step_number);
      content = JSON.stringify({ emails: [{ step_number: step, subject: 'platform hiring signals', body: `Following up on my note below. ${String(user.context.research.summary || '').slice(0, 40)} Would a short call be useful? Unsubscribe: ${user.context.unsubscribe_url}` }] });
    } else {
      content = JSON.stringify({ emails: [1, 2, 3, 4].map((step) => ({ step_number: step, subject: 'platform hiring signals', body: `Batch email ${step}. ${String(user.context.research.summary || '').slice(0, 40)} Would a short call be useful? Unsubscribe: ${user.context.unsubscribe_url}` })) });
    }
  }
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
};

try {
  const db = makeDB();
  const coRes = await db.prepare("INSERT INTO companies(name,domain,website,employees,what_they_do,sub_niche,timezone,created_at) VALUES('Northstar Software','northstar.example','https://northstar.example','80','Analytics software','B2B analytics','America/New_York',date('now'))").run();
  const cRes = await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,cadence,created_at) VALUES(?,'Riley Example','CTO','riley@northstar.example','new',4,date('now'))").bind(coRes.meta.last_row_id).run();
  const contactId = cRes.meta.last_row_id;
  await db.prepare("INSERT INTO research_notes(contact_id,source_type,summary,pain_points,talking_points,fetched_at) VALUES(?,'research_synthesis','Northstar recently added platform reliability roles while growing its analytics product.','[\"Release support is a stated focus\"]','[\"Platform reliability roles were added\",\"Analytics product is growing\",\"Public update highlights release reliability\"]',?)").bind(contactId, new Date().toISOString()).run();
  await db.prepare("UPDATE settings SET value='Alex Origami' WHERE key='sender_name'").run();
  await db.prepare("UPDATE settings SET value='Origami Consulting' WHERE key='sender_company'").run();
  await db.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();

  // Generate and schedule the four drafts.
  await enqueueCopywritingJob(db, contactId, 'https://crm.example');
  const batch = await runCopywritingBatch({ DB: db, GROQ_API_KEY: 'test-key', PUBLIC_APP_URL: 'https://crm.example' }, 1);
  assert.equal(batch.processed, 1);
  const drafts = (await db.prepare('SELECT * FROM email_drafts WHERE contact_id=? ORDER BY step_number').bind(contactId).all()).results;
  assert.equal(drafts.length, 4);

  // Schedule with a fixed send time 8 hours from a fixed reference time
  // (inside the 6-12h refresh window).
  const now = new Date('2026-11-08T06:00:00Z');
  const sendAt = new Date(now.getTime() + 8 * 3600 * 1000).toISOString();
  await db.prepare("UPDATE email_drafts SET status='scheduled',scheduled_at=? WHERE contact_id=?").bind(sendAt, contactId).run();
  await db.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at,created_at,updated_at) VALUES(?,?,'scheduled',?,?,?)").bind(drafts[1].id, contactId, sendAt, sendAt, sendAt).run();

  // New posts/news pasted between sends become the latest research note,
  // newer than the draft's generated_at.
  await db.prepare("INSERT INTO research_notes(contact_id,source_type,summary,pain_points,talking_points,fetched_at) VALUES(?,'news','Northstar published a customer story about faster release cadence.','[\"Release cadence is now a marketing point\"]','[\"Customer story highlights faster releases\"]',?)")
    .bind(contactId, new Date(Date.now() + 60000).toISOString()).run();

  const before = (await db.prepare('SELECT * FROM email_drafts WHERE id=?').bind(drafts[1].id).first());
  assert.ok(!before.body.includes('customer story'), 'precondition: old body lacks newest research');

  fetchCalls = 0;
  const result = await refreshScheduledDrafts({ DB: db, GROQ_API_KEY: 'test-key', PUBLIC_APP_URL: 'https://crm.example' }, db, now, 6, 12);
  assert.equal(result.refreshed, 1, 'one scheduled email refreshed');
  assert.ok(fetchCalls > 0, 'regeneration used the LLM');

  const after = (await db.prepare('SELECT * FROM email_drafts WHERE id=?').bind(drafts[1].id).first());
  assert.ok(after.body.includes('customer story'), 'refreshed body uses the newest research note');
  assert.ok(after.body.includes('/api/track/u/'), 'unsubscribe link preserved');
  assert.equal(after.status, 'scheduled', 'scheduled status preserved');
  assert.equal(after.scheduled_at, sendAt, 'send time preserved');
  assert.ok(Number(after.personalization_score) >= 70);

  // A second tick with no newer research must skip. The refreshed draft is
  // newer than every research note, so nothing is rewritten again.
  await db.prepare("UPDATE email_drafts SET generated_at=? WHERE id=?").bind(new Date(Date.now() + 5 * 60000).toISOString(), drafts[1].id).run();
  const again = await refreshScheduledDrafts({ DB: db, GROQ_API_KEY: 'test-key' }, db, now, 6, 12);
  assert.equal(again.refreshed, 0);
  assert.equal(again.results[0].skipped, 'no_new_research');

  // An email scheduled outside the window is not refreshed even with newer
  // research. The draft is older than the new note again.
  await db.prepare("INSERT INTO research_notes(contact_id,source_type,summary,pain_points,talking_points,fetched_at) VALUES(?,'news','Northstar shipped a new dashboard export feature.','[\"Dashboard export shipped\"]','[\"Export feature reduces manual reporting\"]',?)")
    .bind(contactId, new Date(Date.now() + 120000).toISOString()).run();
  await db.prepare("UPDATE email_drafts SET generated_at=? WHERE id=?").bind(new Date().toISOString(), drafts[1].id).run();
  await db.prepare("UPDATE email_drafts SET scheduled_at=? WHERE contact_id=? AND step_number=2").bind(new Date(now.getTime() + 20 * 3600 * 1000).toISOString(), contactId).run();
  await db.prepare("UPDATE emails SET scheduled_at=? WHERE email_draft_id=?").bind(new Date(now.getTime() + 20 * 3600 * 1000).toISOString(), drafts[1].id).run();
  const outside = await refreshScheduledDrafts({ DB: db, GROQ_API_KEY: 'test-key' }, db, now, 6, 12);
  assert.equal(outside.processed, 0);

  // Sent emails are never refreshed even inside the window.
  await db.prepare("UPDATE emails SET scheduled_at=?,status='sent' WHERE email_draft_id=?").bind(sendAt, drafts[1].id).run();
  const sentTick = await refreshScheduledDrafts({ DB: db, GROQ_API_KEY: 'test-key' }, db, now, 6, 12);
  assert.equal(sentTick.processed, 0);

  db.close();
  console.log('pass: pre-send refresh rewrites only fresh scheduled emails');
  console.log('pre-send refresh: all tests passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enqueueCopywritingJob, regenerateStep, runCopywritingBatch } from '../functions/lib/copywriting.js';

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

const db = makeDB();
const companyInsert = await db.prepare("INSERT INTO companies(name,domain,website,employees,what_they_do,sub_niche,timezone,created_at) VALUES(?,?,?,?,?,?,?,date('now'))")
  .bind('Northstar Software', 'northstar.example', 'https://northstar.example', '80', 'Analytics software for growing teams', 'B2B analytics', 'America/New_York').run();
const contactInsert = await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,cadence,created_at) VALUES(?,?,?,?,'new',4,date('now'))")
  .bind(companyInsert.meta.last_row_id, 'Riley Example', 'CTO', 'riley@northstar.example').run();
const contactId = contactInsert.meta.last_row_id;
await db.prepare("INSERT INTO research_notes(contact_id,source_type,source_url,summary,pain_points,talking_points,fetched_at) VALUES(?,'research_synthesis','https://northstar.example/news','Northstar recently added platform reliability roles while growing its analytics product.','[\"Release support is a stated focus\",\"Engineering capacity may be stretched\"]','[\"Platform reliability roles were added\",\"Analytics product is growing\",\"Public update highlights release reliability\"]',?)")
  .bind(contactId, new Date().toISOString()).run();
await db.prepare("UPDATE settings SET value='Alex Origami' WHERE key='sender_name'").run();
await db.prepare("UPDATE settings SET value='Origami Consulting' WHERE key='sender_company'").run();
await db.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
await db.prepare("INSERT INTO gmail_connections(id,status,email_address,scopes) VALUES(1,'connected','outreach@origami.example','test')").run();

const batchEmails = {
  1: {
    subject: 'platform hiring signals',
    body: 'Your recent update mentions new platform reliability roles while the analytics product grows. Teams in that spot may need more delivery capacity. Origami helps software teams ship product changes without stretching engineering time. Would a fifteen minute chat next week be useful?'
  },
  2: {
    subject: 'analytics release work',
    body: 'Following up on my note below. Your research also mentions a growing analytics product, which can make steady release work more important. Origami adds software delivery capacity without adding pressure to your core team. Would a short call be useful?'
  },
  3: {
    subject: 'one last thought',
    body: 'One last thought on my note below: your team is hiring for platform reliability, a sign that dependable releases matter. If outside delivery support would help, would a 15 minute chat be useful?'
  },
  4: {
    subject: 'closing the loop',
    body: 'Closing the loop on my note below. If a conversation about supporting the analytics release work would be useful, would a short call next week make sense?'
  }
};

let generationCalls = 0;
let scoreCalls = 0;
let regenScoreBase = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const req = JSON.parse(options.body || '{}');
  const system = req.messages.find((m) => m.role === 'system')?.content || '';
  let content;
  if (system.includes('strict, fair email copy editor')) {
    scoreCalls++;
    const user = JSON.parse(req.messages.find((m) => m.role === 'user').content);
    const steps = user.drafts.map((d) => Number(d.step_number));
    let dims;
    if (scoreCalls > regenScoreBase) {
      dims = scoreCalls === regenScoreBase + 1
        ? { word_count: 45, personalization_depth: 55, cta_clarity: 55, subject_line_strength: 55, spam_safety: 95 }
        : { word_count: 45, personalization_depth: 90, cta_clarity: 90, subject_line_strength: 88, spam_safety: 95 };
    } else {
      dims = { word_count: 48, personalization_depth: 90, cta_clarity: 90, subject_line_strength: 88, spam_safety: 95 };
    }
    content = JSON.stringify({ scores: steps.map((s) => ({ step_number: s, ...dims, critique: 'ok' })) });
  } else if (system.includes('Write one personalized outreach email') || system.includes('Revise the supplied low scoring')) {
    generationCalls++;
    const user = JSON.parse(req.messages.find((m) => m.role === 'user').content);
    const step = Number(user.step_number);
    const research = user.context.research;
    content = JSON.stringify({ emails: [{ step_number: step, subject: 'platform hiring signals', body: `Following up on my note below. ${String(research.summary || '').slice(0, 40)} Would a short call be useful? Unsubscribe: ${user.context.unsubscribe_url}` }] });
  } else {
    generationCalls++;
    content = JSON.stringify({ emails: Object.entries(batchEmails).map(([k, v]) => ({ step_number: Number(k), ...v })) });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const queued = await enqueueCopywritingJob(db, contactId, 'https://crm.example');
  assert.equal(queued.queued, true);
  const batchResult = await runCopywritingBatch({ DB: db, GROQ_API_KEY: 'test-key', PUBLIC_APP_URL: 'https://crm.example' }, 1);
  assert.equal(batchResult.processed, 1);
  assert.equal(batchResult.results[0].status, 'ready');

  const drafts = (await db.prepare('SELECT * FROM email_drafts WHERE contact_id=? ORDER BY step_number').bind(contactId).all()).results;
  assert.equal(drafts.length, 4);
  const draft2Before = drafts[1];
  assert.ok(draft2Before.personalization_score >= 70);

  // Simulate email 1 being sent by the worker.
  await db.prepare("UPDATE email_drafts SET status='sent',sent_message_id=1 WHERE contact_id=? AND step_number=1").bind(contactId).run();

  // New posts/news pasted between sends become the latest research note.
  await db.prepare("INSERT INTO research_notes(contact_id,source_type,source_url,summary,pain_points,talking_points,fetched_at) VALUES(?,'news','https://northstar.example/update','Northstar published a customer story about faster release cadence.','[\"Release cadence is now a marketing point\"]','[\"Customer story highlights faster releases\"]',?)")
    .bind(contactId, new Date(Date.now() + 60000).toISOString()).run();

  // Regenerate email 2 with the latest research.
  regenScoreBase = scoreCalls;
  const regen = await regenerateStep({ DB: db, GROQ_API_KEY: 'test-key' }, db, contactId, 2);
  assert.equal(regen.needs_review, false);
  assert.equal(Number(regen.draft.step_number), 2);
  assert.equal(regen.draft.status, 'draft');
  assert.ok(regen.draft.body.includes('Northstar published a customer story'), 'regenerated body uses the newest research note');
  assert.ok(regen.draft.body.includes('/api/track/u/'), 'unsubscribe link preserved');
  assert.ok(Number(regen.draft.personalization_score) >= 70);
  assert.ok(Number(regen.draft.constraints_valid) === 1);
  assert.equal(regen.draft.subject, draft2Before.subject, 'follow-up keeps the shared thread subject');

  // Step 1 stays locked and untouched.
  const sentRow = await db.prepare('SELECT status,sent_message_id FROM email_drafts WHERE contact_id=? AND step_number=1').bind(contactId).first();
  assert.equal(sentRow.status, 'sent');
  assert.equal(Number(sentRow.sent_message_id), 1);

  // The low first score triggered exactly one revision before the final score.
  assert.ok(scoreCalls >= regenScoreBase + 2, 'one low score and one final score');
  assert.ok(generationCalls >= 2, 'initial generation and revision');

  // Error cases.
  await assert.rejects(() => regenerateStep({ DB: db, GROQ_API_KEY: 'test-key' }, db, contactId, 1), /already sent/);
  await assert.rejects(() => regenerateStep({ DB: db, GROQ_API_KEY: 'test-key' }, db, contactId, 5), /1 to 4/);
  await assert.rejects(() => regenerateStep({ DB: db, GROQ_API_KEY: 'test-key' }, db, 99999, 2), /Prospect not found/);

  const otherContact = await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,cadence,created_at) VALUES(?,?,?,?,'new',4,date('now'))").bind(companyInsert.meta.last_row_id, 'Sam Example', 'VP', 'sam@northstar.example').run();
  await db.prepare("INSERT INTO research_notes(contact_id,source_type,source_url,summary,pain_points,talking_points,fetched_at) VALUES(?,'news','https://northstar.example/x','A short summary.','[]','[]',?)").bind(otherContact.meta.last_row_id, new Date().toISOString()).run();
  await assert.rejects(() => regenerateStep({ DB: db, GROQ_API_KEY: 'test-key' }, db, otherContact.meta.last_row_id, 1), /no draft yet/);

  console.log('PASS per-step regeneration with latest research');
} finally {
  globalThis.fetch = originalFetch;
}

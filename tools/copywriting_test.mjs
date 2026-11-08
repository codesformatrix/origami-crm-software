import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildPlan } from '../functions/lib/coach.js';
import { enqueueCopywritingJob, runCopywritingBatch, scoreEditedDraft, scheduleCopywriting } from '../functions/lib/copywriting.js';

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

let url = '';
const emailTexts = {
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
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  assert.match(String(input), /api\.groq\.com/);
  const req = JSON.parse(options.body || '{}');
  const system = req.messages.find((m) => m.role === 'system')?.content || '';
  let content;
  if (system.includes('strict, fair email copy editor')) {
    scoreCalls++;
    const scores = [1, 2, 3, 4].map((step_number) => ({
      step_number,
      word_count: scoreCalls === 1 && step_number === 1 ? 48 : 90,
      personalization_depth: scoreCalls === 1 && step_number === 1 ? 50 : 88,
      cta_clarity: scoreCalls === 1 && step_number === 1 ? 60 : 90,
      subject_line_strength: scoreCalls === 1 && step_number === 1 ? 65 : 88,
      spam_safety: 95,
      critique: scoreCalls === 1 && step_number === 1 ? 'Make the first observation more specific and connect it directly to delivery capacity.' : 'Clear, grounded, and easy to answer.'
    }));
    content = JSON.stringify({ scores });
  } else {
    generationCalls++;
    const emails = Object.entries(emailTexts).map(([step_number, row]) => ({ step_number: Number(step_number), ...row }));
    content = JSON.stringify({ emails });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const queued = await enqueueCopywritingJob(db, contactId, 'https://crm.example');
  assert.equal(queued.queued, true);
  const result = await runCopywritingBatch({ DB: db, GROQ_API_KEY: 'test-key', PUBLIC_APP_URL: 'https://crm.example' }, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].status, 'ready');
  assert.equal(generationCalls, 2, 'one low scoring draft receives exactly one revision');
  assert.equal(scoreCalls, 3, 'initial scoring, revised draft scoring, and final sequence rescore are separate calls');

  const drafts = (await db.prepare('SELECT * FROM email_drafts WHERE contact_id=? ORDER BY step_number').bind(contactId).all()).results;
  url = drafts[0].unsubscribe_url;
  assert.equal(drafts.length, 4);
  assert.ok(drafts.every((draft) => Number(draft.personalization_score) >= 70));
  assert.ok(drafts.every((draft) => Number(draft.constraints_valid) === 1));
  assert.ok(drafts.every((draft) => draft.body.includes(url)));
  assert.ok(drafts.every((draft) => Number(draft.word_count) >= 20));
  assert.ok(drafts[0].word_count < 120);
  assert.equal((drafts[0].subject.match(/\S+/g) || []).length >= 2, true);
  assert.equal(drafts[0].subject, drafts[0].subject.toLowerCase());
  const breakupProse = drafts[3].body.replace(url, '').replace(/^\s*Unsubscribe:\s*.*$/gim, '').trim();
  assert.equal((breakupProse.match(/[.!?](?=\s|$)/g) || []).length, 2);
  assert.equal(drafts.some((draft) => /[\u2010-\u2015\u2212]|\s-\s/.test(draft.body.replace(url, ''))), false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").first()).n, 0, 'generation must never send or log mail');

  const edited = await scoreEditedDraft({ GROQ_API_KEY: 'test-key' }, db, drafts[1].id,
    'analytics release work', drafts[1].body.replace('short call', 'fifteen minute chat'));
  assert.ok(edited.scoring.score >= 70);
  const editedRow = await db.prepare('SELECT is_user_edited,personalization_score FROM email_drafts WHERE id=?').bind(drafts[1].id).first();
  assert.equal(editedRow.is_user_edited, 1);
  assert.ok(editedRow.personalization_score >= 70);

  const scheduled = await scheduleCopywriting(db, contactId);
  assert.equal(scheduled.scheduled, true);
  const scheduledDrafts = (await db.prepare("SELECT * FROM email_drafts WHERE contact_id=? AND status='scheduled' ORDER BY step_number").bind(contactId).all()).results;
  assert.equal(scheduledDrafts.length, 4);
  const initialSend = await db.prepare("SELECT * FROM emails WHERE contact_id=? AND status='scheduled'").bind(contactId).first();
  assert.ok(initialSend, 'explicit scheduling creates the first automatic-send queue record');
  const contact = await db.prepare('SELECT * FROM contacts WHERE id=?').bind(contactId).first();
  const company = await db.prepare('SELECT * FROM companies WHERE id=?').bind(companyInsert.meta.last_row_id).first();
  const plan = buildPlan({ contacts: [contact], companies: [company], templates: [], emailDrafts: scheduledDrafts, messages: [], now: new Date() });
  const planRows = [...plan.sendNow, ...plan.today, ...plan.later];
  const planned = planRows.find((row) => row.contact.id === contactId);
  assert.ok(planned, 'scheduled drafts appear in Jarvis plan');
  assert.equal(planned.draft.emailDraftId, scheduledDrafts[0].id);
  assert.equal(planned.draft.body, scheduledDrafts[0].body);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").first()).n, 0, 'scheduling queues a message but does not directly send it');

  const sequenceId=(await db.prepare("INSERT INTO sequences(name,active) VALUES('Custom cadence',1)").run()).meta.last_row_id;
  for (const [step_order,wait_days] of [[1,0],[2,2],[3,4],[4,5]]) await db.prepare("INSERT INTO sequence_steps(sequence_id,step_order,channel,wait_days) VALUES(?,?,'email',?)").bind(sequenceId,step_order,wait_days).run();
  const secondContact=(await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,timezone,created_at) VALUES(?,?,'CTO',?,'active','America/New_York',date('now'))").bind(companyInsert.meta.last_row_id,'Selected Sequence Prospect','second@northstar.example').run()).meta.last_row_id;
  await db.prepare("INSERT INTO copywriting_jobs(contact_id,status,stage,progress,detail,unsubscribe_url) SELECT ?,status,stage,progress,detail,unsubscribe_url FROM copywriting_jobs WHERE contact_id=?").bind(secondContact,contactId).run();
  await db.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,score_breakdown,score_critique,word_count,constraints_valid,is_user_edited,generated_at) SELECT ?,step_number,'draft',subject,body,unsubscribe_url,personalization_score,score_breakdown,score_critique,word_count,constraints_valid,is_user_edited,generated_at FROM email_drafts WHERE contact_id=?").bind(secondContact,contactId).run();
  const selected=await scheduleCopywriting(db,secondContact,{sequence_id:sequenceId});
  assert.equal(selected.sequence_id,sequenceId);
  assert.ok(selected.enrollment_id);
  const linked=await db.prepare('SELECT sequence_id,enrollment_id FROM emails WHERE contact_id=?').bind(secondContact).first();
  assert.equal(linked.sequence_id,sequenceId); assert.equal(linked.enrollment_id,selected.enrollment_id);
  const replyContact=(await db.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,? ,?,'active','America/New_York')").bind(companyInsert.meta.last_row_id,'Already Replied Prospect','reply@northstar.example').run()).meta.last_row_id;
  await db.prepare("INSERT INTO replies(prospect_id,raw_text) VALUES(?, 'Reply before scheduling')").bind(replyContact).run();
  await assert.rejects(()=>scheduleCopywriting(db,replyContact,{use_default:true}),/reply is already recorded/i);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM emails WHERE contact_id=?").bind(replyContact).first()).n,0,'reply guard prevents sequence queue creation');
  console.log('PASS copywriting queue, one-time revision, scoring, per-sequence cadence enrollment, reply guard, and human-reviewed scheduling');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
}

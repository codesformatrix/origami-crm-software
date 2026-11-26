import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyReplyClassification, resumeOutOfOfficeSequences, classifyAndStoreReply } from '../functions/lib/gmail.js';
import { hashEmail } from '../functions/lib/compliance.js';

function makeDB() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid || 0) } }; },
        async first() { return raw.prepare(sql).get(...args) || null; },
        async all() { return { results: raw.prepare(sql).all(...args) }; },
      };
    },
    close() { raw.close(); },
  };
}

const db = makeDB();
try {
  await db.prepare("INSERT INTO companies(name,domain,timezone) VALUES('OOO Co','ooo.example','UTC')").run();
  const company = await db.prepare('SELECT id FROM companies').first();
  await db.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','UTC')")
    .bind(company.id, 'Morgan OOO', 'morgan@ooo.example').run();
  const contact = await db.prepare('SELECT id FROM contacts').first();
  await db.prepare("INSERT INTO sequences(name,active) VALUES('Reply test',1)").run();
  const sequence = await db.prepare('SELECT id FROM sequences').first();
  await db.prepare("INSERT INTO enrollments(contact_id,sequence_id,status,step_index,started_at) VALUES(?,?,'active',1,?)")
    .bind(contact.id, sequence.id, '2026-11-09T09:00:00.000Z').run();
  await db.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body) VALUES(?,2,'scheduled','Follow-up','Hello')")
    .bind(contact.id).run();
  const draft = await db.prepare('SELECT id FROM email_drafts').first();
  await db.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-10T09:00:00.000Z')")
    .bind(draft.id, contact.id).run();
  await db.prepare("INSERT INTO replies(prospect_id,received_at,raw_text) VALUES(?,?,?)")
    .bind(contact.id, '2026-11-09T09:00:00.000Z', 'I am out of office until November 12.').run();
  const reply = await db.prepare('SELECT id FROM replies').first();
  const ooo = await applyReplyClassification(db, reply.id, 'out_of_office', '2026-11-12', new Date('2026-11-09T10:00:00.000Z'));
  assert.equal(ooo.classification, 'out_of_office');
  assert.equal(ooo.return_date, '2026-11-12');
  const enrollment = await db.prepare('SELECT status,stop_reason,next_step_at FROM enrollments WHERE contact_id=?').bind(contact.id).first();
  assert.equal(enrollment.status, 'paused');
  assert.equal(enrollment.stop_reason, 'out_of_office');
  assert.equal(enrollment.next_step_at, '2026-11-16T09:00:00.000Z', 'next step schedules after the return date in the safe send window');
  const queued = await db.prepare('SELECT status,last_error FROM emails WHERE contact_id=?').bind(contact.id).first();
  assert.equal(queued.status, 'paused_reply');
  assert.equal(queued.last_error, 'out_of_office:2026-11-12');
  await resumeOutOfOfficeSequences(db, new Date(ooo.resumes_at));
  assert.equal((await db.prepare('SELECT status FROM enrollments WHERE contact_id=?').bind(contact.id).first()).status, 'active');
  assert.equal((await db.prepare('SELECT status FROM emails WHERE contact_id=?').bind(contact.id).first()).status, 'scheduled');
  assert.equal((await db.prepare('SELECT status FROM contacts WHERE id=?').bind(contact.id).first()).status, 'active');

  await db.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','UTC')")
    .bind(company.id, 'Taylor Opt Out', 'taylor@ooo.example').run();
  const contact2 = await db.prepare("SELECT id FROM contacts WHERE email='taylor@ooo.example'").first();
  await db.prepare("INSERT INTO replies(prospect_id,received_at,raw_text) VALUES(?,?,?)")
    .bind(contact2.id, '2026-11-09T09:00:00.000Z', 'Please do not contact me again.').run();
  const reply2 = await db.prepare("SELECT id FROM replies WHERE prospect_id=?").bind(contact2.id).first();
  await applyReplyClassification(db, reply2.id, 'not_interested', '', new Date('2026-11-09T10:00:00.000Z'));
  assert.equal((await db.prepare('SELECT status FROM contacts WHERE id=?').bind(contact2.id).first()).status, 'do_not_contact');
  const taylorHash = await hashEmail('taylor@ooo.example');
  assert.equal((await db.prepare("SELECT reason FROM suppressed_email_hashes WHERE email_hash=?").bind(taylorHash).first()).reason, 'not_interested');

  await db.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'active')")
    .bind(company.id, 'Jordan Unsubscribe', 'jordan@ooo.example').run();
  const contact3 = await db.prepare("SELECT id FROM contacts WHERE email='jordan@ooo.example'").first();
  await db.prepare("INSERT INTO replies(prospect_id,received_at,raw_text) VALUES(?,?,?)")
    .bind(contact3.id, '2026-11-09T09:00:00.000Z', 'Unsubscribe.').run();
  const reply3 = await db.prepare("SELECT id FROM replies WHERE prospect_id=?").bind(contact3.id).first();
  await applyReplyClassification(db, reply3.id, 'unsubscribe', '', new Date('2026-11-09T10:00:00.000Z'));
  const jordanHash = await hashEmail('jordan@ooo.example');
  assert.equal((await db.prepare("SELECT reason FROM suppressed_email_hashes WHERE email_hash=?").bind(jordanHash).first()).reason, 'unsubscribe');
  await db.prepare('DELETE FROM contacts WHERE id=?').bind(contact3.id).run();
  assert.ok(await db.prepare("SELECT email_hash FROM suppressed_email_hashes WHERE email_hash=?").bind(jordanHash).first(), 'permanent hashed suppression survives contact deletion');
  await db.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'active')")
    .bind(company.id, 'Morgan Keyword Opt Out', 'morgan@ooo.example').run();
  const contact4 = await db.prepare("SELECT id FROM contacts WHERE email='morgan@ooo.example'").first();
  const reply4 = (await db.prepare("INSERT INTO replies(prospect_id,received_at,raw_text) VALUES(?,?,?)")
    .bind(contact4.id, '2026-11-09T11:00:00.000Z', 'Please opt out of future messages.').run()).meta.last_row_id;
  await classifyAndStoreReply({}, db, reply4, 'Please opt out of future messages.', '2026-11-09T11:00:00.000Z');
  assert.equal((await db.prepare('SELECT classification FROM replies WHERE id=?').bind(reply4).first()).classification, 'unsubscribe');
  assert.equal((await db.prepare('SELECT status FROM contacts WHERE id=?').bind(contact4.id).first()).status, 'unsubscribed');
  assert.ok(await db.prepare('SELECT email_hash FROM suppressed_email_hashes WHERE email_hash=?').bind(await hashEmail('morgan@ooo.example')).first());
  console.log('PASS deterministic opt-out phrase classification without an LLM call');
  console.log('PASS OOO pause/reschedule, not-interested DNC, unsubscribe suppression, and contact-deletion persistence');
} finally { db.close(); }

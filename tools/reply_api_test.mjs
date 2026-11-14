import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/[[path]].js';
import { hashEmail } from '../functions/lib/compliance.js';

const raw = new DatabaseSync(':memory:');
raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() { const result = raw.prepare(sql).run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } }; },
      async first() { return raw.prepare(sql).get(...args) || null; },
      async all() { return { results: raw.prepare(sql).all(...args) }; },
    };
  },
};
const env = { DB, APP_KEY: 'test-session-key' };
async function call(path, method = 'GET', body, cookie = '') {
  const request = new Request(`https://crm.example/api/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return onRequest({ request, env, params: { path: path.split('/').filter(Boolean) } });
}
try {
  const login = await call('login', 'POST', { key: env.APP_KEY });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await DB.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Inbox Co','inbox.example','UTC')").run();
  const company = await DB.prepare('SELECT id FROM companies').first();
  await DB.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'replied')")
    .bind(company.id, 'Casey Inbox', 'casey@inbox.example').run();
  const contact = await DB.prepare('SELECT id FROM contacts').first();
  await DB.prepare("INSERT INTO messages(contact_id,channel,direction,subject,body,sent_at,created_at,gmail_message_id,thread_id) VALUES(?,'email','out','Planning call','Original outreach','2026-11-08T08:00:00Z','2026-11-08T08:00:00Z','sent-1','thread-1')")
    .bind(contact.id).run();
  await DB.prepare("INSERT INTO messages(contact_id,channel,direction,subject,body,sent_at,created_at,gmail_message_id,thread_id) VALUES(?,'email','in','Re: Planning call','Could we talk on Tuesday?','2026-11-08T09:00:00Z','2026-11-08T09:00:00Z','reply-1','thread-1')")
    .bind(contact.id).run();
  const inbound = await DB.prepare("SELECT id FROM messages WHERE gmail_message_id='reply-1'").first();
  await DB.prepare("INSERT INTO replies(email_id,prospect_id,received_at,classification,raw_text,gmail_message_id,thread_id,suggested_reply) VALUES(?,?,?,'positive',?,?,?,'Thanks, Tuesday works for me.')")
    .bind(inbound.id, contact.id, '2026-11-08T09:00:00Z', 'Could we talk on Tuesday?', 'reply-1', 'thread-1').run();
  const reply = await DB.prepare('SELECT id FROM replies').first();

  let response = await call('inbox', 'GET', undefined, cookie);
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.replies[0].thread_messages.length, 2);
  assert.equal(payload.replies[0].suggested_reply, 'Thanks, Tuesday works for me.');
  response = await call(`replies/${reply.id}`, 'PUT', { suggested_reply: 'I can do Tuesday at 2 pm. Does that suit you?' }, cookie);
  assert.equal(response.status, 200);
  response = await call(`replies/${reply.id}`, 'PUT', { handled: true }, cookie);
  assert.equal(response.status, 200);
  let stored = await DB.prepare('SELECT suggested_reply,handled_at FROM replies WHERE id=?').bind(reply.id).first();
  assert.match(stored.suggested_reply, /Tuesday at 2 pm/);
  assert.ok(stored.handled_at);
  response = await call('inbox', 'GET', undefined, cookie);
  payload = await response.json();
  assert.equal(payload.replies[0].thread_messages.length, 2);
  assert.ok(payload.replies[0].handled_at);

  response = await call(`replies/${reply.id}`, 'PUT', { classification: 'not_interested' }, cookie);
  assert.equal(response.status, 200);
  assert.equal((await DB.prepare('SELECT status FROM contacts WHERE id=?').bind(contact.id).first()).status, 'do_not_contact');
  const caseyHash = await hashEmail('casey@inbox.example');
  assert.equal((await DB.prepare("SELECT reason FROM suppressed_email_hashes WHERE email_hash=?").bind(caseyHash).first()).reason, 'not_interested');
  response = await call('prospects', 'POST', { name: 'Another Casey', company: 'New Co', email: 'casey@inbox.example' }, cookie);
  assert.equal(response.status, 409, 'manual creation rejects permanently suppressed email');
  response = await call('import/csv', 'POST', { rows: [{ Email: 'casey@inbox.example', Company: 'New Co', Name: 'Another Casey' }], mapping: { email: 'Email', company: 'Company', contact: 'Name' } }, cookie);
  assert.equal(response.status, 200);
  const imported = await response.json();
  assert.equal(imported.createdContacts, 0);
  assert.equal(imported.skipped, 1, 'CSV import skips permanently suppressed email');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 1);
  console.log('PASS Inbox threads, suggested-reply editing, handled state, classification effects, and permanent suppression on manual/CSV imports');
} finally { raw.close(); }

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beginGmailOAuth, finishGmailOAuth, gmailStatus, runGmailSendBatch, scheduleBusinessDays } from '../functions/lib/gmail.js';

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
const scopes = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
];
const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'local-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'local-client-secret',
  GMAIL_TOKEN_ENCRYPTION_KEY: 'local-test-encryption-key-change-me-0123456789',
};
async function connect(db, origin = 'https://crm.example') {
  const authUrl = new URL(await beginGmailOAuth(env, db, origin));
  assert.equal(authUrl.searchParams.get('access_type'), 'offline');
  assert.ok(authUrl.searchParams.get('code_challenge'));
  assert.deepEqual(authUrl.searchParams.get('scope').split(' '), scopes);
  const callback = new URL(`${origin}/api/gmail/oauth/callback`);
  callback.searchParams.set('state', authUrl.searchParams.get('state'));
  callback.searchParams.set('code', 'one-time-code');
  const response = await finishGmailOAuth(env, db, callback.toString());
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /gmail=connected/);
  const row = await db.prepare('SELECT * FROM gmail_connections WHERE id=1').first();
  assert.equal(row.status, 'connected');
  assert.ok(!row.refresh_token_enc.includes('fake-refresh-token'), 'refresh token must be encrypted at rest');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM gmail_oauth_states').first()).n, 0, 'OAuth state is one-time use');
  return row;
}
function b64urlText(text) { return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function decodeMime(raw) {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4);
  const mime = atob(padded);
  const [headers, body] = mime.split(/\r\n\r\n/);
  const encoded = body.replace(/\s+/g, '');
  return { headers, body: atob(encoded) };
}
async function registerUnsubscribe(db, contactId, link) {
  const token = new URL(link).pathname.split('/').pop();
  await db.prepare("INSERT INTO tracking(token,contact_id,kind,target,created_at) VALUES(?,?,'unsubscribe','',date('now'))").bind(token,contactId).run();
}
const originalFetch = globalThis.fetch;
let mode = 'thread'; let sendCalls = 0; let replySync = false; let replyClassificationCalls = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url === 'https://api.groq.com/openai/v1/chat/completions') {
    replyClassificationCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ classification: 'positive', return_date: '', suggested_reply: 'Thanks for the reply. A short call next week works for me.' }) } }] }), { status: 200 });
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(options.body || '');
    if (form.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expires_in: 3600, scope: scopes.join(' ') }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'refreshed-access-token', expires_in: 3600, scope: scopes.join(' ') }), { status: 200 });
  }
  if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
  if (url.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: 'outreach@origami.example', historyId: 'hist-1' }), { status: 200 });
  if (url.includes('/history?')) {
    if (replySync && mode === 'bounce') return new Response(JSON.stringify({ history: [{ messagesAdded: [{ message: { id: 'bounce-1', threadId: 'bounce-notice-1' } }, { message: { id: 'bounce-2', threadId: 'bounce-notice-2' } }] }], historyId: 'hist-bounce' }), { status: 200 });
    if (replySync && mode === 'thread') return new Response(JSON.stringify({ history: [{ messagesAdded: [{ message: { id: 'reply-1', threadId: 'thread-1' } }] }], historyId: 'hist-3' }), { status: 200 });
    return new Response(JSON.stringify({ history: [], historyId: replySync ? 'hist-3' : 'hist-2' }), { status: 200 });
  }
  if (url.includes('/messages/send')) {
    sendCalls++;
    const body = JSON.parse(options.body || '{}');
    const mime = decodeMime(body.raw);
    assert.match(mime.body, /123 Origami Street, Jabalpur, MP, India/);
    assert.match(mime.body, /https:\/\/crm\.example\/api\/track\/u\//);
    assert.match(mime.headers, /List-Unsubscribe: <https:\/\/crm\.example\/api\/track\/u\//);
    assert.match(mime.headers, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    if (mode === 'quota') return new Response(JSON.stringify({ error: { message: 'quota limit', errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    if (mode === 'bounce') return new Response(JSON.stringify({ id:`gmail-bounce-seed-${sendCalls}`,threadId:`thread-bounce-${sendCalls}` }), { status:200 });
    if (sendCalls === 1) {
      assert.equal(body.threadId, undefined);
      return new Response(JSON.stringify({ id: 'gmail-msg-1', threadId: 'thread-1' }), { status: 200 });
    }
    if (mode === 'thread' && sendCalls === 2) {
      assert.equal(body.threadId, 'thread-1');
      assert.match(mime.headers, /In-Reply-To: <gmail-msg-1@origami\.example>/);
      assert.match(mime.headers, /References: <gmail-msg-1@origami\.example>/);
      return new Response(JSON.stringify({ id: 'gmail-msg-2', threadId: 'thread-1' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: `gmail-msg-${sendCalls}`, threadId: 'thread-1' }), { status: 200 });
  }
  if (url.includes('/messages/gmail-bounce-seed-')) {
    const id=url.includes('gmail-bounce-seed-2')?'gmail-bounce-seed-2':'gmail-bounce-seed-1';
    return new Response(JSON.stringify({payload:{headers:[{name:'Message-ID',value:`<${id}@origami.example>`}]}}),{status:200});
  }
  if (url.includes('/messages/gmail-msg-')) {
    const id = url.includes('gmail-msg-2') ? 'gmail-msg-2' : 'gmail-msg-1';
    return new Response(JSON.stringify({ payload: { headers: [{ name: 'Message-ID', value: `<${id}@origami.example>` }] } }), { status: 200 });
  }
  if (url.includes('/threads/thread-1?format=full')) {
    return new Response(JSON.stringify({ messages: [{ id: 'reply-1', internalDate: String(Date.now()), payload: {
      headers: [{ name: 'From', value: 'Riley Example <riley@northstar.example>' }, { name: 'Subject', value: 'platform hiring signals' }],
      mimeType: 'text/plain', body: { data: b64urlText('Thanks for reaching out. A short call next week could work.') },
    } }] }), { status: 200 });
  }
  if (url.includes('/messages/reply-1?format=full')) {
    return new Response(JSON.stringify({ internalDate: String(Date.now()), payload: {
      headers: [{ name: 'From', value: 'Riley Example <riley@northstar.example>' }, { name: 'Subject', value: 'platform hiring signals' }],
      mimeType: 'text/plain', body: { data: b64urlText('Thanks for reaching out. A short call next week could work.') },
    } }), { status: 200 });
  }
  if (url.includes('/messages/bounce-1?format=metadata') || url.includes('/messages/bounce-2?format=metadata')) {
    const n=url.includes('bounce-2')?'2':'1';
    return new Response(JSON.stringify({payload:{headers:[{name:'From',value:'Mail Delivery Subsystem <mailer-daemon@gmail.com>'},{name:'Subject',value:'Delivery Status Notification (Failure)'},{name:'In-Reply-To',value:`<gmail-bounce-seed-${n}@origami.example>`}]}}),{status:200});
  }
  if (url.includes('/messages/bounce-1?format=full') || url.includes('/messages/bounce-2?format=full')) {
    const n = url.includes('bounce-2') ? '2' : '1';
    return new Response(JSON.stringify({ internalDate:String(Date.now()),payload:{headers:[{name:'From',value:'Mail Delivery Subsystem <mailer-daemon@gmail.com>'},{name:'Subject',value:'Delivery Status Notification (Failure)'},{name:'In-Reply-To',value:`<gmail-bounce-seed-${n}@origami.example>`}],mimeType:'text/plain',body:{data:b64urlText(`Delivery failed. Final-Recipient: rfc822; user${n}@bad.example Action: failed Status: 5.1.1 Address not found.`)}}}),{status:200});
  }
  throw new Error('Unexpected Gmail test request: ' + url);
};

try {
  assert.equal(scheduleBusinessDays(new Date('2026-11-09T14:30:00Z'),3,'America/New_York').toISOString(),'2026-11-12T14:00:00.000Z','three business days lands Thursday at 9am local');
  assert.equal(scheduleBusinessDays(new Date('2026-11-06T15:00:00Z'),1,'America/New_York').toISOString(),'2026-11-09T14:00:00.000Z','Friday plus one business day skips weekend');
  assert.equal(scheduleBusinessDays(new Date('2026-11-12T14:30:00Z'),1,'America/New_York').toISOString(),'2026-11-16T14:00:00.000Z','Friday delivery window rolls to next Monday');
  const db = makeDB();
  try {
    await connect(db);
    await db.prepare("INSERT INTO companies(name,domain,timezone,created_at) VALUES('Northstar Software','northstar.example','America/New_York',date('now'))").run();
    const company = await db.prepare('SELECT id FROM companies LIMIT 1').first();
    await db.prepare("INSERT INTO contacts(company_id,name,title,email,status,cadence,timezone,created_at) VALUES(?,?,?,?, 'new',1,'America/New_York',date('now'))")
      .bind(company.id, 'Riley Example', 'CTO', 'riley@northstar.example').run();
    const contact = await db.prepare('SELECT * FROM contacts LIMIT 1').first();
    await db.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
    await db.prepare("UPDATE settings SET value='Alex Origami' WHERE key='sender_name'").run();
    const link = `https://crm.example/api/track/u/${'a'.repeat(48)}`;
    await registerUnsubscribe(db, contact.id, link);
    const body = `Your recent update mentions platform reliability roles and analytics growth. Would a 15 minute call be useful?\n\nUnsubscribe: ${link}`;
    for (let step = 1; step <= 4; step++) {
      await db.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid,scheduled_at) VALUES(?,?,'scheduled','platform hiring signals',?,?,90,1,?)")
        .bind(contact.id, step, body, link, step === 1 ? '2026-11-09T14:00:00.000Z' : null).run();
    }
    const firstDraft = await db.prepare('SELECT id FROM email_drafts WHERE contact_id=? AND step_number=1').bind(contact.id).first();
    await db.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-09T14:00:00.000Z')")
      .bind(firstDraft.id, contact.id).run();
    const now = new Date('2026-11-09T14:30:00.000Z'); // Monday, 09:30 in New York
    const first = await runGmailSendBatch({ ...env, DB: db }, now);
    assert.equal(first.status, 'sent', JSON.stringify({first, row: await db.prepare('SELECT status,last_error FROM emails WHERE email_draft_id=?').bind(firstDraft.id).first(), attempts: await db.prepare('SELECT status,error FROM email_send_attempts').all()}));
    const sent1 = await db.prepare("SELECT * FROM emails WHERE email_draft_id=?").bind(firstDraft.id).first();
    assert.equal(sent1.gmail_message_id, 'gmail-msg-1');
    assert.equal(sent1.thread_id, 'thread-1');
    assert.equal(sent1.rfc_message_id, '<gmail-msg-1@origami.example>');
    assert.equal((await db.prepare("SELECT status FROM email_send_attempts WHERE email_id=?").bind(sent1.id).first()).status, 'sent');
    const outgoing = await db.prepare("SELECT body FROM messages WHERE direction='out' AND contact_id=?").bind(contact.id).first();
    assert.match(outgoing.body, /123 Origami Street/);
    assert.match(outgoing.body, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(Number((await db.prepare("SELECT sent_message_id FROM email_drafts WHERE id=?").bind(firstDraft.id).first()).sent_message_id) > 0);

    const second = await db.prepare("SELECT * FROM emails WHERE contact_id=? AND status='scheduled' AND email_draft_id<>? LIMIT 1").bind(contact.id, firstDraft.id).first();
    assert.ok(second, 'next sequence step is queued after successful first send');
    assert.equal(second.scheduled_at,'2026-11-12T14:00:00.000Z','default cadence waits three business days and targets local 9am');
    await db.prepare("UPDATE emails SET scheduled_at='2026-11-10T15:00:00.000Z' WHERE id=?").bind(second.id).run();
    const secondRun = await runGmailSendBatch({ ...env, DB: db }, new Date('2026-11-10T15:00:00.000Z'));
    assert.equal(secondRun.status, 'sent');
    assert.equal(sendCalls, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM provider_usage WHERE provider='gmail_send' AND window_type='day'").first()).n, 2);

    replySync = true;
    const replyRun = await runGmailSendBatch({ ...env, GROQ_API_KEY: 'reply-test-key', GROQ_MODEL: 'test-model', DB: db }, new Date('2026-11-10T15:15:00.000Z'));
    assert.ok(['idle','outside_window'].includes(replyRun.status));
    assert.equal((await db.prepare('SELECT status FROM contacts WHERE id=?').bind(contact.id).first()).status, 'replied');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM replies WHERE prospect_id=?").bind(contact.id).first()).n, 1);
    const detectedReply = await db.prepare('SELECT * FROM replies WHERE prospect_id=?').bind(contact.id).first();
    assert.equal(detectedReply.classification, 'positive');
    assert.match(detectedReply.suggested_reply, /^Thanks for the reply/);
    assert.equal(detectedReply.thread_id, 'thread-1');
    assert.equal((await db.prepare("SELECT status FROM emails WHERE thread_id='thread-1' ORDER BY id LIMIT 1").first()).status, 'replied');
    assert.equal(replyClassificationCalls, 1, 'classification and draft suggestion share one LLM operation');
    assert.ok((await db.prepare("SELECT COUNT(*) AS n FROM emails WHERE contact_id=? AND status='paused_reply'").bind(contact.id).first()).n >= 1);
    await runGmailSendBatch({ ...env, GROQ_API_KEY: 'reply-test-key', GROQ_MODEL: 'test-model', DB: db }, new Date('2026-11-10T15:25:00.000Z'));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM replies WHERE prospect_id=?").bind(contact.id).first()).n, 1, 'replaying Gmail history does not duplicate a reply');
    assert.equal(replyClassificationCalls, 1, 'duplicate Gmail history does not reclassify');
    assert.equal(sendCalls, 2, 'reply detection pauses later sends');
    const status = await gmailStatus(db, env);
    assert.equal(status.status, 'connected');
    console.log('PASS OAuth offline flow, encrypted token storage, compliant send window, CAN-SPAM footer, thread headers, attempt log, and reply pause');
  } finally { db.close(); }

  mode = 'quota'; sendCalls = 0; replySync = false;
  const db2 = makeDB();
  try {
    await connect(db2);
    await db2.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Quota Co','quota.example','America/New_York')").run();
    const company = await db2.prepare('SELECT id FROM companies LIMIT 1').first();
    await db2.prepare("INSERT INTO contacts(company_id,name,email,status,cadence,timezone) VALUES(?,? ,?,'active',4,'America/New_York')").bind(company.id, 'Quota Prospect', 'quota@quota.example').run();
    const contact = await db2.prepare('SELECT * FROM contacts LIMIT 1').first();
    await db2.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
    const link = `https://crm.example/api/track/u/${'b'.repeat(48)}`;
    await registerUnsubscribe(db2, contact.id, link);
    await db2.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,1,'scheduled','one useful note','A useful short note.\n\nUnsubscribe: '||?, ?,90,1)")
      .bind(contact.id, link, link).run();
    const draft = await db2.prepare('SELECT id FROM email_drafts WHERE contact_id=?').bind(contact.id).first();
    await db2.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-09T14:30:00.000Z')").bind(draft.id, contact.id).run();
    const result = await runGmailSendBatch({ ...env, DB: db2 }, new Date('2026-11-09T14:30:00.000Z'));
    assert.equal(result.status, 'failed_quota');
    assert.equal(sendCalls, 3, 'Gmail 429 is retried at most three times');
    const email = await db2.prepare('SELECT status FROM emails WHERE id=1').first();
    assert.equal(email.status, 'failed');
    assert.equal((await db2.prepare('SELECT COUNT(*) AS n FROM email_send_attempts WHERE email_id=1').first()).n, 3);
    assert.equal((await db2.prepare("SELECT used FROM provider_usage WHERE provider='gmail_send' AND window_type='day'").first()).used, 0, 'failed attempts do not consume successful-send cap');
    console.log('PASS Gmail quota retry budget, failed status, and daily-cap rollback');
  } finally { db2.close(); }
  mode='thread'; replySync=false; sendCalls=0;
  const db3=makeDB();
  try {
    await connect(db3);
    await db3.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Reply Guard Co','guard.example','America/New_York')").run();
    const co=await db3.prepare('SELECT id FROM companies LIMIT 1').first();
    await db3.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,? ,?,'active','America/New_York')").bind(co.id,'Replied Prospect','reply@guard.example').run();
    const person=await db3.prepare('SELECT * FROM contacts LIMIT 1').first();
    const sq=(await db3.prepare("INSERT INTO sequences(name,active) VALUES('Guard cadence',1)").run()).meta.last_row_id;
    for(let i=1;i<=4;i++) await db3.prepare("INSERT INTO sequence_steps(sequence_id,step_order,channel,wait_days) VALUES(?,?,'email',?)").bind(sq,i,[0,3,4,5][i-1]).run();
    const enrollment=(await db3.prepare("INSERT INTO enrollments(contact_id,sequence_id,status,next_step_at,started_at) VALUES(?,?,'active',?,?)").bind(person.id,sq,'2026-11-09T14:30:00Z','2026-11-09T14:30:00Z').run()).meta.last_row_id;
    const msg=(await db3.prepare("INSERT INTO messages(contact_id,channel,direction) VALUES(?,'email','in')").bind(person.id).run()).meta.last_row_id;
    await db3.prepare("INSERT INTO replies(email_id,prospect_id,raw_text) VALUES(?,?,?)").bind(msg,person.id,'Already replied').run();
    await db3.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
    const link='https://crm.example/api/track/u/guard';
    const draft=(await db3.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,1,'scheduled','Test',?,?,90,1)").bind(person.id,`A useful note.\n\nUnsubscribe: ${link}`,link).run()).meta.last_row_id;
    await db3.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at,sequence_id,enrollment_id) VALUES(?,?,'scheduled','2026-11-09T14:30:00Z',?,?)").bind(draft,person.id,sq,enrollment).run();
    const blocked=await runGmailSendBatch({...env,DB:db3},new Date('2026-11-09T14:30:00Z'));
    assert.equal(blocked.status,'idle'); assert.equal(sendCalls,0,'any recorded reply blocks all sends');
    assert.equal((await db3.prepare('SELECT status FROM emails WHERE id=1').first()).status,'paused_reply');
    const enr=await db3.prepare('SELECT status,stop_reason FROM enrollments WHERE id=?').bind(enrollment).first();
    assert.equal(enr.status,'stopped'); assert.equal(enr.stop_reason,'replied');
    console.log('PASS pre-send any-reply guard, business-day cadence, weekday window roll-forward, and enrollment stop reason');
  } finally { db3.close(); }

  mode='bounce'; replySync=false; sendCalls=0;
  const db4=makeDB();
  try {
    await connect(db4);
    await db4.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Bounce Co','bad.example','America/New_York')").run();
    const co=await db4.prepare('SELECT id FROM companies LIMIT 1').first();
    await db4.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
    const ids=[];
    for(const [index,name,email] of [[1,'Bounce One','user1@bad.example'],[2,'Bounce Two','user2@bad.example'],[3,'Protected Third','user3@bad.example']]) {
      await db4.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','America/New_York')").bind(co.id,name,email).run();
      const person=await db4.prepare('SELECT * FROM contacts WHERE email=?').bind(email).first();
      const link=`https://crm.example/api/track/u/${String(index).repeat(48)}`;
      await registerUnsubscribe(db4,person.id,link);
      const draft=(await db4.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,1,'scheduled','Test',?,?,90,1)").bind(person.id,`A useful note.\n\nUnsubscribe: ${link}`,link).run()).meta.last_row_id;
      await db4.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-09T14:30:00.000Z')").bind(draft,person.id).run();
      ids.push({contact:person.id,email});
    }
    const send1=await runGmailSendBatch({...env,DB:db4},new Date('2026-11-09T14:30:00Z')); assert.equal(send1.status,'sent');
    const send2=await runGmailSendBatch({...env,DB:db4},new Date('2026-11-09T14:34:00Z')); assert.equal(send2.status,'sent',JSON.stringify({send2,emails:(await db4.prepare('SELECT id,contact_id,status,scheduled_at,last_error FROM emails').all()).results}));
    replySync=true;
    const bounce=await runGmailSendBatch({...env,DB:db4},new Date('2026-11-09T14:40:00Z'));
    assert.ok(['paused_domain','idle'].includes(bounce.status));
    assert.equal((await db4.prepare('SELECT status FROM contacts WHERE email=?').bind(ids[0].email).first()).status,'bounced');
    assert.equal((await db4.prepare('SELECT status FROM contacts WHERE email=?').bind(ids[1].email).first()).status,'bounced');
    assert.equal((await db4.prepare("SELECT bounce_count FROM domain_suppressions WHERE domain='bad.example'").first()).bounce_count,2);
    assert.equal((await db4.prepare("SELECT e.status FROM emails e JOIN contacts c ON c.id=e.contact_id WHERE c.email=?").bind(ids[2].email).first()).status,'paused_domain');
    console.log('PASS Gmail bounce detection stops prospects and suppresses domains after the second bounce');
  } finally { db4.close(); }
  mode='thread'; replySync=false; sendCalls=0;
  const db5=makeDB();
  try {
    await connect(db5);
    await db5.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Cadence Co','cadence.example','America/New_York')").run();
    const co=await db5.prepare('SELECT id FROM companies LIMIT 1').first();
    await db5.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','America/New_York')").bind(co.id,'Cadence Prospect','cadence@cadence.example').run();
    const person=await db5.prepare('SELECT * FROM contacts LIMIT 1').first();
    await db5.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
    const sq=(await db5.prepare("INSERT INTO sequences(name,active) VALUES('Custom business cadence',1)").run()).meta.last_row_id;
    const waits=[0,2,7,1];
    for(let i=1;i<=4;i++) await db5.prepare("INSERT INTO sequence_steps(sequence_id,step_order,channel,wait_days) VALUES(?,?,'email',?)").bind(sq,i,waits[i-1]).run();
    const enrollment=(await db5.prepare("INSERT INTO enrollments(contact_id,sequence_id,step_index,status,next_step_at,started_at) VALUES(?, ?,0,'active',?,?)").bind(person.id,sq,'2026-11-09T14:30:00.000Z','2026-11-09T14:30:00.000Z').run()).meta.last_row_id;
    const link=`https://crm.example/api/track/u/${'c'.repeat(48)}`;
    await registerUnsubscribe(db5,person.id,link);
    for(let i=1;i<=4;i++) {
      const draft=(await db5.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,?,'scheduled','custom cadence',?,?,90,1)").bind(person.id,i,`Useful message ${i}.\n\nUnsubscribe: ${link}`,link).run()).meta.last_row_id;
      if(i===1) await db5.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at,sequence_id,enrollment_id) VALUES(?,?,'scheduled','2026-11-09T14:30:00.000Z',?,?)").bind(draft,person.id,sq,enrollment).run();
    }
    const result=await runGmailSendBatch({...env,DB:db5},new Date('2026-11-09T14:30:00Z'));
    assert.equal(result.status,'sent');
    const follow=await db5.prepare("SELECT * FROM emails WHERE contact_id=? AND status='scheduled'").bind(person.id).first();
    assert.equal(follow.scheduled_at,'2026-11-11T14:00:00.000Z','sequence-specific two-business-day delay overrides default and targets 9am local');
    const progress=await db5.prepare('SELECT step_index,next_step_at FROM enrollments WHERE id=?').bind(enrollment).first();
    assert.equal(progress.step_index,1); assert.equal(progress.next_step_at,follow.scheduled_at);
    console.log('PASS per-sequence cadence drives the next send and advances enrollment progress');
  } finally { db5.close(); }
  mode='thread'; replySync=false; sendCalls=0;
  const db6=makeDB();
  try {
    await connect(db6);
    await db6.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Ramp Co','ramp.example','America/New_York')").run();
    const co=await db6.prepare('SELECT id FROM companies LIMIT 1').first();
    await db6.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','America/New_York')").bind(co.id,'Ramp Prospect','ramp@ramp.example').run();
    const person=await db6.prepare('SELECT * FROM contacts LIMIT 1').first();
    const link=`https://crm.example/api/track/u/${'d'.repeat(48)}`;
    await registerUnsubscribe(db6,person.id,link);
    const draft=(await db6.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,1,'scheduled','platform fit','A useful note.\\n\\nUnsubscribe: '||?, ?,90,1)").bind(person.id,link,link).run()).meta.last_row_id;
    await db6.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-09T14:30:00.000Z')").bind(draft,person.id).run();
    const noAddress=await runGmailSendBatch({...env,DB:db6},new Date('2026-11-09T14:30:00Z'));
    assert.equal(noAddress.status,'paused_config'); assert.equal(sendCalls,0,'missing physical address blocks the Gmail API call');
    assert.match((await db6.prepare('SELECT last_error FROM emails').first()).last_error,/physical mailing address/);
    await db6.prepare("UPDATE settings SET value='123 Origami Street, Jabalpur, MP, India' WHERE key='physical_mailing_address'").run();
    await db6.prepare("UPDATE emails SET status='scheduled',last_error='' WHERE id=1").run();
    await db6.prepare("UPDATE settings SET value='1' WHERE key='master_send_paused'").run();
    const paused=await runGmailSendBatch({...env,DB:db6},new Date('2026-11-09T14:30:00Z'));
    assert.equal(paused.status,'master_paused'); assert.equal(sendCalls,0,'master pause blocks the Gmail API call');
    await db6.prepare("UPDATE settings SET value='0' WHERE key='master_send_paused'").run();
    await db6.prepare("INSERT INTO provider_usage(provider,window_type,window_key,used,updated_at) VALUES('gmail_send','day','2026-11-09',5,'2026-11-09T14:00:00Z')").run();
    const capped=await runGmailSendBatch({...env,DB:db6},new Date('2026-11-09T14:30:00Z'));
    assert.equal(capped.status,'daily_cap'); assert.equal(sendCalls,0,'week-one cap blocks a sixth send');
    await db6.prepare("UPDATE provider_usage SET used=4 WHERE provider='gmail_send' AND window_type='day' AND window_key='2026-11-09'").run();
    const rampSend=await runGmailSendBatch({...env,DB:db6},new Date('2026-11-09T14:30:00Z'));
    assert.equal(rampSend.status,'sent'); assert.equal(sendCalls,1,'week-one fifth send is allowed');
    await db6.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','America/New_York')").bind(co.id,'Wrong Token Prospect','wrong-token@ramp.example').run();
    const other=await db6.prepare("SELECT * FROM contacts WHERE email='wrong-token@ramp.example'").first();
    const otherDraft=(await db6.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,1,'scheduled','platform fit','A useful note',?,90,1)").bind(other.id,link).run()).meta.last_row_id;
    await db6.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-09T14:30:00.000Z')").bind(otherDraft,other.id).run();
    const wrongToken=await runGmailSendBatch({...env,DB:db6},new Date('2026-11-09T14:30:00Z'));
    assert.equal(wrongToken.status,'paused_config'); assert.match(wrongToken.reason,/does not belong/); assert.equal(sendCalls,1,'another prospect’s unsubscribe token is rejected');
    console.log('PASS master pause, warmup cap, required mailing address, and prospect-specific unsubscribe ownership are enforced');
  } finally { db6.close(); }
} finally {
  globalThis.fetch = originalFetch;
}

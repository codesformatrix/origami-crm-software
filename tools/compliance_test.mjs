import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/[[path]].js';
import { hashEmail, isEmailSuppressed, warmupCap, deceptiveSubjectReason } from '../functions/lib/compliance.js';

const raw = new DatabaseSync(':memory:');
raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() { const result=raw.prepare(sql).run(...args); return { meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid||0)} }; },
      async first() { return raw.prepare(sql).get(...args)||null; },
      async all() { return { results:raw.prepare(sql).all(...args) }; },
    };
  },
};
const env = { DB, APP_KEY:'compliance-test-key' };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://cloudflare-dns.com');
  const name = url.searchParams.get('name');
  let value = '';
  if (name === 'outreach.example') value = '"v=spf1 include:_spf.google.com ~all"';
  else if (name === 'google._domainkey.outreach.example') value = '"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"';
  else if (name === '_dmarc.outreach.example') value = '"v=DMARC1; p=none; rua=mailto:dmarc@outreach.example"';
  return new Response(JSON.stringify({ Status:0, Answer:value ? [{ type:16,data:value }] : [] }), { status:200, headers:{'content-type':'application/dns-json'} });
};
async function call(path, method='GET', body, cookie='') {
  const request = new Request(`https://crm.example/api/${path}`, {
    method,
    headers:{ ...(body===undefined?{}:{'content-type':'application/json'}), ...(cookie?{Cookie:cookie}:{}) },
    body:body===undefined?undefined:JSON.stringify(body),
  });
  return onRequest({request,env,params:{path:path.split('/').filter(Boolean)}});
}
try {
  assert.equal(warmupCap('2026-11-07',25,new Date('2026-11-07T12:00:00Z')).cap,5);
  assert.equal(warmupCap('2026-11-01',25,new Date('2026-11-08T12:00:00Z')).cap,10);
  assert.equal(warmupCap('2026-10-25',25,new Date('2026-11-08T12:00:00Z')).cap,15);
  assert.equal(warmupCap('2026-10-10',25,new Date('2026-11-08T12:00:00Z')).cap,25);
  assert.equal(warmupCap('2026-10-10',8,new Date('2026-11-08T12:00:00Z')).cap,8);
  assert.match(deceptiveSubjectReason('Re: platform hiring signals',false),/cannot imply/i);
  assert.match(deceptiveSubjectReason('Urgent action required',false),/misleading/i);
  assert.equal(deceptiveSubjectReason('platform hiring signals',false),'');
  assert.equal(deceptiveSubjectReason('platform hiring signals',true),'');

  const login = await call('login','POST',{key:env.APP_KEY});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  let response=await call('settings','POST',{sender_name:'Origami Sender',sender_company:'Origami',physical_mailing_address:'  123 Example St, Jabalpur, MP 482001, India  '},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare("SELECT value FROM settings WHERE key='physical_mailing_address'").first()).value,'123 Example St, Jabalpur, MP 482001, India');
  response=await call('settings','POST',{sending_domain:'not a domain'},cookie);
  assert.equal(response.status,400);
  const today = new Date().toISOString().slice(0,10);
  response=await call('settings','POST',{domain_start:today},cookie);
  assert.equal(response.status,200,'a valid warmup start date is accepted');
  response=await call('deliverability/dns-check','POST',{domain:'outreach.example',dkim_selector:'google'},cookie);
  assert.equal(response.status,200);
  const dns=await response.json();
  assert.equal(dns.all_pass,true);
  assert.ok(dns.checks.spf.pass && dns.checks.dkim.pass && dns.checks.dmarc.pass);
  response=await call('settings','POST',{deliverability_wizard_complete:'1'},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare("SELECT value FROM settings WHERE key='deliverability_wizard_complete'").first()).value,'1');
  response=await call('settings','POST',{sending_domain:'other.example'},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare("SELECT value FROM settings WHERE key='deliverability_wizard_complete'").first()).value,'0','changing the sending domain invalidates the old DNS pass');
  response=await call('settings','POST',{deliverability_wizard_complete:'1'},cookie);
  assert.equal(response.status,409,'a prior DNS pass for another domain cannot complete the wizard');
  response=await call('deliverability/dns-check','POST',{domain:'outreach.example',dkim_selector:'google'},cookie);
  assert.equal((await response.json()).all_pass,true);
  response=await call('settings','POST',{deliverability_wizard_complete:'1'},cookie);
  assert.equal(response.status,200);

  await DB.prepare("INSERT INTO companies(name,domain,timezone) VALUES('Compliance Co','outreach.example','UTC')").run();
  const company=await DB.prepare('SELECT id FROM companies').first();
  await DB.prepare("INSERT INTO contacts(company_id,name,email,status,timezone) VALUES(?,?,?,'active','UTC')").bind(company.id,'Queued Person','queued@outreach.example').run();
  const queued=await DB.prepare("SELECT id FROM contacts WHERE email='queued@outreach.example'").first();
  const draftId=(await DB.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,unsubscribe_url,personalization_score,constraints_valid) VALUES(?,1,'scheduled','business note','Text','https://crm.example/api/track/u/queued-token',90,1)").bind(queued.id).run()).meta.last_row_id;
  await DB.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at) VALUES(?,?,'scheduled','2026-11-09T09:00:00Z')").bind(draftId,queued.id).run();
  response=await call('settings','POST',{master_send_paused:'1'},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare('SELECT status FROM emails').first()).status,'paused_master');
  response=await call('gmail/status','GET',undefined,cookie);
  assert.equal((await response.json()).master_paused,true);
  response=await call('settings','POST',{master_send_paused:'0'},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare('SELECT status FROM emails').first()).status,'scheduled');

  await DB.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'new')").bind(company.id,'Unsubscribe Click','click@outreach.example').run();
  const clickPerson=await DB.prepare("SELECT id FROM contacts WHERE email='click@outreach.example'").first();
  await DB.prepare("INSERT INTO tracking(token,contact_id,kind,target) VALUES(?,?,'unsubscribe','')").bind('unsub-token',clickPerson.id).run();
  response=await call('track/u/unsub-token','GET');
  assert.equal(response.status,200);
  assert.match(await response.text(),/immediately/i);
  assert.equal((await DB.prepare('SELECT status FROM contacts WHERE id=?').bind(clickPerson.id).first()).status,'unsubscribed');
  assert.ok(await DB.prepare("SELECT id FROM events WHERE contact_id=? AND type='optout'").bind(clickPerson.id).first());
  const clickHash=await hashEmail('click@outreach.example');
  assert.ok(await DB.prepare('SELECT email_hash FROM suppressed_email_hashes WHERE email_hash=?').bind(clickHash).first());
  assert.equal(await isEmailSuppressed(DB,'CLICK@OUTREACH.EXAMPLE'),true);
  response=await call(`contacts/${clickPerson.id}/status`,'POST',{status:'active'},cookie);
  assert.equal(response.status,409,'a prior opt-out cannot be reactivated');
  response=await call(`contacts/${clickPerson.id}`,'PUT',{status:'active',email:'new-address@outreach.example'},cookie);
  assert.equal(response.status,409,'an opt-out cannot be bypassed by changing the contact email');
  response=await call(`contacts/${clickPerson.id}`,'DELETE',undefined,cookie);
  assert.equal(response.status,200);
  const erasedSuppression=await DB.prepare('SELECT email_hash,reason,source FROM suppressed_email_hashes WHERE email_hash=?').bind(clickHash).first();
  assert.ok(erasedSuppression,'hashed opt-out survives erasure');
  assert.equal(erasedSuppression.source,'erasure_preservation','erasure removes linked source metadata from the suppression digest');
  assert.equal(await DB.prepare("SELECT email FROM suppressed_emails WHERE email='click@outreach.example'").first(),null,'erasure removes the clear-text suppression row');

  await DB.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'active')").bind(company.id,'Consent Test','consent@outreach.example').run();
  const consent=await DB.prepare("SELECT id FROM contacts WHERE email='consent@outreach.example'").first();
  response=await call(`contacts/${consent.id}/consent`,'POST',{action:'withdrawn',channel:'email',source:'request received 2026-11-07'},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare('SELECT status FROM contacts WHERE id=?').bind(consent.id).first()).status,'do_not_contact');
  response=await call(`contacts/${consent.id}/consent`,'POST',{action:'granted',channel:'email',source:'later message'},cookie);
  assert.equal((await response.json()).suppressed,true,'a consent grant cannot undo a previous permanent opt-out');
  response=await call(`contacts/${consent.id}/messages`,'POST',{channel:'email',subject:'Hello',body:'Follow up'},cookie);
  assert.equal(response.status,409,'outbound logging/send path blocks permanently suppressed emails');

  await DB.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'active')").bind(company.id,'Manual Opt Out','manual-optout@outreach.example').run();
  const manual=await DB.prepare("SELECT id FROM contacts WHERE email='manual-optout@outreach.example'").first();
  response=await call(`contacts/${manual.id}/replies`,'POST',{channel:'email',subject:'Re: outreach',body:'Please opt out of future messages.'},cookie);
  assert.equal(response.status,200);
  assert.equal((await DB.prepare('SELECT status FROM contacts WHERE id=?').bind(manual.id).first()).status,'unsubscribed','manually logged reply opt-out is deterministic too; '+JSON.stringify({replies:await DB.prepare('SELECT * FROM replies WHERE prospect_id=?').bind(manual.id).all(),body:'Please opt out of future messages.'}));
  assert.ok(await DB.prepare('SELECT email_hash FROM suppressed_email_hashes WHERE email_hash=?').bind(await hashEmail('manual-optout@outreach.example')).first());

  await DB.prepare("INSERT INTO contacts(company_id,name,email,status) VALUES(?,?,?,'active')").bind(company.id,'Erase This Person','erase@outreach.example').run();
  const erase=await DB.prepare("SELECT id FROM contacts WHERE email='erase@outreach.example'").first();
  const project=(await DB.prepare("INSERT INTO outreach_projects(name) VALUES('Project')").run()).meta.last_row_id;
  await DB.prepare('INSERT INTO project_members(project_id,contact_id) VALUES(?,?)').bind(project,erase.id).run();
  await DB.prepare("INSERT INTO messages(contact_id,channel,direction,body) VALUES(?,'email','in','private message')").bind(erase.id).run();
  await DB.prepare("INSERT INTO tasks(title,contact_id) VALUES('Follow up',?)").bind(erase.id).run();
  await DB.prepare("INSERT INTO research_notes(contact_id,summary) VALUES(?,'private research')").bind(erase.id).run();
  await DB.prepare("INSERT INTO tracking(token,contact_id,kind) VALUES('erase-token',?,'click')").bind(erase.id).run();
  response=await call(`contacts/${erase.id}`,'DELETE',undefined,cookie);
  assert.equal(response.status,200);
  assert.equal(await DB.prepare('SELECT id FROM contacts WHERE id=?').bind(erase.id).first(),null);
  for (const table of ['messages','tasks','research_notes','project_members','tracking']) assert.equal(await DB.prepare(`SELECT rowid FROM ${table} WHERE ${table==='project_members'?'contact_id':table==='tracking'?'contact_id':'contact_id'}=?`).bind(erase.id).first(),null,`${table} removed`);
  assert.ok(await DB.prepare("SELECT id FROM events WHERE type='erasure' AND contact_id IS NULL AND company_id IS NULL").first(),'anonymous erasure audit event retained');
  assert.equal(await DB.prepare("SELECT email_hash FROM suppressed_email_hashes WHERE email_hash=?").bind(await hashEmail('erase@outreach.example')).first(),null,'ordinary erasure does not create an opt-out for an active person');
  console.log('PASS warmup ramp, subject safety, DNS wizard, mailing address, immediate unsubscribe, master pause, consent withdrawal, hashed suppression, and full erasure');
} finally {
  globalThis.fetch=originalFetch;
  raw.close();
}

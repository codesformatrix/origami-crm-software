import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/[[path]].js';

const raw = new DatabaseSync(':memory:');
raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) { let args=[]; return { bind(...values){args=values;return this;}, async run(){const r=raw.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid||0)}};}, async first(){return raw.prepare(sql).get(...args)||null;}, async all(){return {results:raw.prepare(sql).all(...args)};} }; },
};
const env = { DB, APP_KEY:'dashboard-test-secret', GROQ_API_KEY:'secret-groq-test-value' };
async function call(path,method='GET',body,cookie='') {
  const url=`https://crm.example/api/${path}`;
  const request=new Request(url,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return onRequest({request,env,params:{path:path.split('?')[0].split('/').filter(Boolean)}});
}
const originalFetch=globalThis.fetch;
try {
  const login=await call('login','POST',{key:env.APP_KEY}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const now=new Date().toISOString(), day=now.slice(0,10);
  await DB.prepare("INSERT INTO companies(name,domain,timezone,country,country_key) VALUES('Dash Co','dash.example','Asia/Kolkata','India','in')").run();
  const company=await DB.prepare('SELECT id FROM companies').first();
  await DB.prepare("INSERT INTO contacts(company_id,name,title,email,status,timezone,touch_count,created_at) VALUES(?,?,?,?,'replied','Asia/Kolkata',1,?)")
    .bind(company.id,'Ari Dashboard','CTO','ari@dash.example',day).run();
  const contact=await DB.prepare('SELECT id FROM contacts').first();
  await DB.prepare("INSERT INTO research_notes(contact_id,source_type,summary,icp_score,icp_reason,fetched_at) VALUES(?,'research_synthesis','Three verified details about platform reliability.',82,'Strong decision-maker and service fit.',?)")
    .bind(contact.id,now).run();
  await DB.prepare("INSERT INTO sequences(name,active,created_at) VALUES('Active sequence',1,?)").bind(day).run();
  const sequence=await DB.prepare('SELECT id FROM sequences').first();
  await DB.prepare("INSERT INTO enrollments(contact_id,sequence_id,status,step_index,started_at) VALUES(?,?,'active',0,?)").bind(contact.id,sequence.id,now).run();
  await DB.prepare("INSERT INTO enrollments(contact_id,sequence_id,status,step_index,started_at) VALUES(?,?,'paused',1,?)").bind(contact.id,sequence.id,now).run();
  await DB.prepare("INSERT INTO email_drafts(contact_id,step_number,status,subject,body,generated_at) VALUES(?,1,'sent','Subject','Body',?)").bind(contact.id,now).run();
  const draft=await DB.prepare('SELECT id FROM email_drafts').first();
  await DB.prepare("INSERT INTO emails(email_draft_id,contact_id,status,scheduled_at,sent_at,thread_id) VALUES(?,?,'replied',?,?, 'thread-dashboard')")
    .bind(draft.id,contact.id,now,now).run();
  await DB.prepare("INSERT INTO messages(contact_id,direction,subject,body,sent_at,created_at,gmail_message_id,thread_id) VALUES(?,'out','Subject','Body',?,?, 'sent-dashboard','thread-dashboard')")
    .bind(contact.id,day,now).run();
  await DB.prepare("INSERT INTO messages(contact_id,direction,subject,body,sent_at,created_at,gmail_message_id,thread_id) VALUES(?,'in','Re: Subject','Thanks',?,?, 'reply-dashboard','thread-dashboard')")
    .bind(contact.id,now,now).run();
  const inbound=await DB.prepare("SELECT id FROM messages WHERE gmail_message_id='reply-dashboard'").first();
  await DB.prepare("INSERT INTO replies(email_id,prospect_id,received_at,classification,raw_text,gmail_message_id,thread_id) VALUES(?,? ,?,'positive','Thanks','reply-dashboard','thread-dashboard')")
    .bind(inbound.id,contact.id,now).run();
  await DB.prepare("INSERT INTO enrichment_jobs(contact_id,status,stage,progress,detail,error,attempts,queued_at,updated_at) VALUES(?,'completed','complete',100,'done','',1,?,?)").bind(contact.id,now,now).run();
  await DB.prepare("INSERT INTO provider_usage(provider,window_type,window_key,used,updated_at) VALUES('groq','day',?,4,?)").bind(day,now).run();
  await DB.prepare("UPDATE settings SET value='25' WHERE key='daily_send_cap'").run();

  let response=await call('dashboard','GET',undefined,cookie); assert.equal(response.status,200);
  const dashboard=await response.json();
  assert.equal(dashboard.overview.sends_today,1);
  assert.equal(dashboard.overview.daily_cap,25);
  assert.equal(dashboard.overview.reply_rate_30d,100);
  assert.equal(dashboard.overview.open_rate,null);
  assert.equal(dashboard.overview.sequences_active,1);
  assert.equal(dashboard.overview.sequences_paused,1);
  assert.equal(dashboard.overview.quotas.find((x)=>x.provider==='groq').used,4);
  assert.equal(dashboard.overview.digest.enriched,1);
  assert.equal(dashboard.overview.digest.drafted,1);
  assert.equal(dashboard.overview.digest.replies,1);

  response=await call(`people?min_icp=80&timezone=Asia%2FKolkata&sort=icp`,'GET',undefined,cookie);
  const people=await response.json();
  assert.equal(people.people.length,1);
  assert.equal(people.people[0].icp_reason,'Strong decision-maker and service fit.');
  assert.match(people.people[0].research_summary,/platform reliability/);
  response=await call(`people?min_icp=90`,'GET',undefined,cookie);
  assert.equal((await response.json()).people.length,0);
  await DB.prepare("INSERT INTO contacts(company_id,name,title,email,status,timezone,created_at) VALUES(?,?,?,?,'active','Asia/Kolkata',?)")
    .bind(company.id,'Sam Enrich','CTO','sam@dash.example',day).run();
  const enrichContact=await DB.prepare("SELECT id FROM contacts WHERE email='sam@dash.example'").first();
  response=await call(`contacts/${enrichContact.id}/enrich`,'POST',{run_now:true},cookie);
  const enrichNow=await response.json();
  assert.equal(response.status,200);
  assert.equal(enrichNow.processed,1,'Enrich now runs only the selected prospect immediately');
  assert.equal(enrichNow.result.status,'needs_configuration','missing research providers do not trigger retries');
  await DB.prepare("INSERT INTO copywriting_jobs(contact_id,status,error,queued_at,updated_at) VALUES(?,'failed',?,?,?)")
    .bind(contact.id,'groq request failed with secret-groq-test-value',now,now).run();
  response=await call('dashboard','GET',undefined,cookie);
  const errorDigest=(await response.json()).overview.digest.errors;
  assert.ok(errorDigest.some((row)=>row.api==='Groq'));
  assert.ok(!JSON.stringify(errorDigest).includes(env.GROQ_API_KEY),'daily digest redacts provider secrets');

  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),'https://api.groq.com/openai/v1/models');
    assert.equal(options.headers.Authorization,'Bearer '+env.GROQ_API_KEY);
    return new Response(JSON.stringify({data:[]}),{status:200});
  };
  response=await call('providers/test','POST',{provider:'groq'},cookie);
  const test=await response.json();
  assert.equal(test.ok,true);
  assert.ok(!JSON.stringify(test).includes(env.GROQ_API_KEY),'provider test never returns the API key');
  console.log('PASS dashboard metrics, daily digest, status/quota API, ICP/timezone filters, research fields, and server-only provider test');
} finally { globalThis.fetch=originalFetch; raw.close(); }

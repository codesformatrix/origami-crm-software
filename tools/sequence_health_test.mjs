import assert from 'node:assert/strict';

const base=(process.argv[2]||'http://127.0.0.1:8788').replace(/\/$/,'');
const password=process.env.CRM_TEST_PASSWORD;
assert.ok(password,'set CRM_TEST_PASSWORD to the local APP_KEY');
let cookie='';
async function req(path,method='GET',body){
  const response=await fetch(base+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const setCookie=response.headers.get('set-cookie'); if(setCookie) cookie=setCookie.split(';')[0];
  const raw=await response.text(); let data={}; try{data=JSON.parse(raw)}catch{}
  return {response,data};
}
const login=await req('/api/login','POST',{key:password}); assert.equal(login.response.status,200);
const originalSettings=(await req('/api/settings')).data;
const health=await req('/api/sequence-health'); assert.equal(health.response.status,200); assert.ok(Array.isArray(health.data.sequences));
let sequenceId=null,companyId=null,contactId=null;
try{
  const saved=await req('/api/settings','POST',{gmail_step2_business_days:2,gmail_step3_business_days:4,gmail_step4_business_days:5});
  assert.equal(saved.response.status,200);
  const settings=(await req('/api/settings')).data;
  assert.equal(settings.gmail_step2_business_days,'2');
  const sequence=await req('/api/sequences','POST',{name:`Health fixture ${Date.now()}`,description:'Sequence health test'});
  assert.equal(sequence.response.status,200); sequenceId=sequence.data.id;
  for(const [step_order,wait_days] of [[1,0],[2,3],[3,4],[4,5]]){
    const step=await req(`/api/sequences/${sequenceId}/steps`,'POST',{channel:'email',subject:`Step ${step_order}`,body:'Reviewed test content',wait_days});
    assert.equal(step.response.status,200);
  }
  const details=await req(`/api/sequences/${sequenceId}`);
  assert.deepEqual(details.data.steps.map(x=>x.wait_days),[0,3,4,5]);
  const changed=await req(`/api/steps/${details.data.steps[1].id}`,'PUT',{wait_days:2});
  assert.equal(changed.response.status,200);
  assert.equal((await req(`/api/sequences/${sequenceId}`)).data.steps[1].wait_days,2);
  const prospect=await req('/api/prospects','POST',{name:'Sequence Health Prospect',email:`health-${Date.now()}@example.test`,company:'Sequence Health Fixture',domain:`health-${Date.now()}.example.test`,title:'CTO'});
  assert.equal(prospect.response.status,200); contactId=prospect.data.id; companyId=prospect.data.company_id;
  const enrolled=await req(`/api/sequences/${sequenceId}/enroll`,'POST',{contact_ids:[contactId]});
  assert.equal(enrolled.response.status,200); assert.equal(enrolled.data.enrolled,1);
  const reply=await req(`/api/contacts/${contactId}/replies`,'POST',{channel:'email',subject:'Re: hello',body:'Thanks, we have already replied.'});
  assert.equal(reply.response.status,200);
  const afterReply=await req('/api/sequence-health');
  const row=afterReply.data.sequences.find(x=>x.contact_id===contactId);
  assert.equal(row.status,'paused'); assert.equal(row.pause_reason,'replied');
  assert.equal((await req(`/api/contacts/${contactId}`)).data.contact.status,'replied');
  console.log('PASS Settings default cadence, per-sequence business-day overrides, sequence enrollment, reply stop reason, and Sequence Health');
} finally {
  if(contactId) await req(`/api/contacts/${contactId}`,'DELETE');
  if(companyId) await req(`/api/companies/${companyId}`,'DELETE');
  if(sequenceId) await req(`/api/sequences/${sequenceId}`,'DELETE');
  await req('/api/settings','POST',{
    gmail_step2_business_days:originalSettings.gmail_step2_business_days ?? '3',
    gmail_step3_business_days:originalSettings.gmail_step3_business_days ?? '4',
    gmail_step4_business_days:originalSettings.gmail_step4_business_days ?? '5'
  });
  await req('/api/logout','POST',{});
}

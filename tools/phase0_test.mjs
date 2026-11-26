import assert from 'node:assert/strict';

const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const password = process.env.CRM_TEST_PASSWORD;
assert.ok(password, 'Set CRM_TEST_PASSWORD to the local APP_KEY used by Wrangler');
let cookie = '';
async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(base + path, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  return response;
}
async function json(path, options = {}) {
  const response = await request(path, options);
  const data = await response.json();
  assert.ok(response.ok, `${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}
const send = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
await json('/api/login', send('POST', { key: password }));
const originalSettings = await json('/api/settings');
const marker = `Phase 0 QA ${Date.now()}`;
const domain = marker.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.invalid';
let companyId = null, sequenceId = null;
try {
  const company = await json('/api/companies', send('POST', { name: marker, domain, hq: 'Toronto, Canada' }));
  companyId = company.id;
  const contact = await json(`/api/companies/${companyId}/contacts`, send('POST', { name: marker + ' Contact', title: 'Founder' }));

  const note = await json('/api/research', send('POST', {
    contact_id: contact.id, source_type: 'linkedin_manual', source_url: 'https://example.invalid/post/1',
    summary: 'Manually pasted public post context', pain_points: ['legacy platform'], talking_points: ['migration experience'],
  }));
  let research = await json('/api/research?contact_id=' + contact.id);
  assert.ok(research.notes.some((n) => n.id === note.id && n.source_type === 'linkedin_manual'));

  await json(`/api/contacts/${contact.id}/replies`, send('POST', { channel: 'email', subject: 'Re: intro', body: 'Please remove me from your list.' }));
  let inbox = await json('/api/inbox');
  const reply = inbox.replies.find((r) => r.prospect_id === contact.id);
  assert.ok(reply, 'manual reply logging should feed the Inbox page');
  assert.equal(reply.classification, 'neutral');
  await json(`/api/replies/${reply.reply_id}`, send('PUT', { classification: 'unsubscribe' }));

  const updated = await json(`/api/contacts/${contact.id}`);
  assert.equal(updated.contact.status, 'unsubscribed');
  const blocked = await request(`/api/contacts/${contact.id}/messages`, send('POST', { subject: 'Should not send', body: 'blocked' }));
  assert.equal(blocked.status, 409, 'outbound message logging must fail closed for unsubscribed contacts');

  const seq = await json('/api/sequences', send('POST', { name: marker + ' sequence' }));
  sequenceId = seq.id;
  const enrollment = await json(`/api/sequences/${sequenceId}/enroll`, send('POST', { contact_ids: [contact.id] }));
  assert.equal(enrollment.enrolled, 0);
  assert.equal(enrollment.suppressed, 1, 'suppressed contacts must not enter a sequence');

  await json('/api/settings', send('POST', {
    sender_name: 'QA Sender', sender_company: 'Origami Consulting', physical_mailing_address: '1 QA Street, Jabalpur, India',
    sending_window_start_hour: '9', sending_window_end_hour: '17',
  }));
  const settings = await json('/api/settings');
  assert.equal(settings.sender_name, 'QA Sender');
  assert.equal(settings.physical_mailing_address, '1 QA Street, Jabalpur, India');
  assert.equal(settings.sending_window_start_hour, '9');
  assert.equal(settings.sending_window_end_hour, '17');
  console.log('PASS Phase 0 research/reply schema, inbox, sender settings, and unsubscribe/sequence suppression guard');
} finally {
  await request('/api/settings', send('POST', {
    sender_name: originalSettings.sender_name || '',
    sender_company: originalSettings.sender_company || '',
    physical_mailing_address: originalSettings.physical_mailing_address || '',
    sending_window_start_hour: originalSettings.sending_window_start_hour || '9',
    sending_window_end_hour: originalSettings.sending_window_end_hour || '17',
  }));
  if (sequenceId) await request(`/api/sequences/${sequenceId}`, { method: 'DELETE' });
  if (companyId) await request(`/api/companies/${companyId}`, { method: 'DELETE' });
  await request('/api/logout', { method: 'POST' });
}

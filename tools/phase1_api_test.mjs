import assert from 'node:assert/strict';
const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const password = process.env.CRM_TEST_PASSWORD;
assert.ok(password, 'set CRM_TEST_PASSWORD to the local APP_KEY');
let cookie = '';
async function req(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  return { response, data };
}
const login = await req('/api/login', 'POST', { key: password });
assert.equal(login.response.status, 200);
const email = `phase1-${Date.now()}@example.test`;
const created = await req('/api/prospects', 'POST', {
  name: 'Phase One Fixture', email, company: 'Phase One Fixture Co', domain: `phase1-${Date.now()}.example.test`,
  title: 'CTO', linkedin_url: 'https://www.linkedin.com/in/phase-one-fixture'
});
assert.equal(created.response.status, 200, JSON.stringify(created.data));
assert.equal(created.data.queued, true);
const contactId = created.data.id, companyId = created.data.company_id;
try {
  const duplicate = await req('/api/prospects', 'POST', { name: 'Duplicate', email, company: 'Another Company' });
  assert.equal(duplicate.response.status, 409, 'manual prospects dedupe by email');

  const detail = await req(`/api/contacts/${contactId}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.data.enrichment.status, 'queued');
  assert.ok(Array.isArray(detail.data.research_notes));
  assert.equal(detail.data.contact.linkedin, 'https://www.linkedin.com/in/phase-one-fixture');

  const badLinkedIn = await req(`/api/contacts/${contactId}/linkedin-research`, 'POST', { url: 'https://example.test/post' });
  assert.equal(badLinkedIn.response.status, 400);
  const noProvider = await req(`/api/contacts/${contactId}/linkedin-research`, 'POST', { text: 'A manually pasted test post.' });
  assert.equal(noProvider.response.status, 400, 'without configured AI, manual synthesis fails closed');

  const invalidSettings = await req('/api/settings', 'POST', { icp_company_size_min: '-1' });
  assert.equal(invalidSettings.response.status, 400, 'ICP size settings are validated');

  const usage = await req('/api/enrichment/usage');
  assert.equal(usage.response.status, 200);
  assert.ok(Array.isArray(usage.data.queue));

  const csvEmail = `csv-${Date.now()}@phase1.example.test`;
  const imported = await req('/api/import/csv', 'POST', {
    rows: [
      { name: 'CSV Phase Prospect', email: csvEmail, company: 'CSV Phase Company', title: 'VP Engineering', linkedin_url: 'https://www.linkedin.com/in/csv-phase' },
      { name: 'Duplicate CSV Prospect', email: csvEmail.toUpperCase(), company: 'CSV Phase Company', title: 'VP Engineering', linkedin_url: 'https://www.linkedin.com/in/csv-phase' },
    ],
    mapping: { contact: 'name', email: 'email', company: 'company', title: 'title', dm_linkedin: 'linkedin_url' },
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.createdContacts, 1);
  assert.equal(imported.data.skipped, 1, 'CSV deduplicates by normalized email');
  const people = await req('/api/people?q=' + encodeURIComponent('CSV Phase Prospect'));
  const csvPerson = people.data.people.find((x) => x.email === csvEmail);
  assert.ok(csvPerson);
  const csvDetail = await req(`/api/contacts/${csvPerson.id}`);
  assert.equal(csvDetail.data.enrichment.status, 'queued');
  assert.equal(csvDetail.data.contact.linkedin, 'https://www.linkedin.com/in/csv-phase');
  const csvCompanies = await req('/api/companies?q=' + encodeURIComponent('CSV Phase Company'));
  for (const person of people.data.people) await req(`/api/contacts/${person.id}`, 'DELETE');
  for (const company of csvCompanies.data.companies) await req(`/api/companies/${company.id}`, 'DELETE');
} finally {
  await req(`/api/contacts/${contactId}`, 'DELETE');
  await req(`/api/companies/${companyId}`, 'DELETE');
}
await req('/api/logout', 'POST', {});
console.log('PASS Phase 1 prospect API, deduplication, queue, manual LinkedIn guard, ICP validation, usage API');

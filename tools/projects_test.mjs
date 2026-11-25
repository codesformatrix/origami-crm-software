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
const marker = `Project QA ${Date.now()}`;
const domainBase = marker.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.invalid';
let projectId = null;
const companyIds = [];
try {
  const canada = await json('/api/companies', send('POST', {
    name: marker + ' CA', domain: 'ca.' + domainBase, hq: 'ProjectTestLand, Canada', city: 'ProjectTestLand', country: 'Canada',
  }));
  companyIds.push(canada.id);
  const autoPerson = await json(`/api/companies/${canada.id}/contacts`, send('POST', { name: marker + ' CTO', title: 'QA Director of Technomancy' }));

  const other = await json('/api/companies', send('POST', {
    name: marker + ' Other', domain: 'other.' + domainBase, hq: 'Elsewhere, Canada', city: 'Elsewhere', country: 'Canada',
  }));
  companyIds.push(other.id);
  const manualPerson = await json(`/api/companies/${other.id}/contacts`, send('POST', { name: marker + ' Manual', title: 'QA Director of Technomancy' }));

  const created = await json('/api/projects', send('POST', {
    name: marker, description: 'Project test context', title_terms: 'QA Director of Technomancy',
    location_terms: 'ProjectTestLand', match_mode: 'all',
  }));
  projectId = created.id;
  assert.ok(created.auto_added >= 1, 'creating a rule should match existing eligible contacts');
  let project = await json(`/api/projects/${projectId}`);
  assert.ok(project.members.some((p) => p.id === autoPerson.id && p.source === 'auto'));
  assert.ok(!project.members.some((p) => p.id === manualPerson.id));

  await json(`/api/projects/${projectId}/members`, send('POST', { action: 'add', contact_ids: [manualPerson.id] }));
  project = await json(`/api/projects/${projectId}`);
  assert.ok(project.members.some((p) => p.id === manualPerson.id && p.source === 'manual'));
  await json(`/api/projects/${projectId}/members`, send('POST', { action: 'remove', contact_ids: [autoPerson.id, manualPerson.id] }));
  await json(`/api/projects/${projectId}/sync`, send('POST', {}));
  project = await json(`/api/projects/${projectId}`);
  assert.equal(project.members.length, 0, 'manual remove and auto-match exclusion should remain under user control');

  await json(`/api/projects/${projectId}/members`, send('POST', { action: 'add', contact_ids: [autoPerson.id] }));
  const imported = await json('/api/import/csv', send('POST', {
    rows: [{ Company: marker + ' Import', Domain: 'import.' + domainBase, Name: marker + ' Imported', Title: 'QA Director of Technomancy', Location: 'ProjectTestLand, Canada', Email: marker.toLowerCase().replace(/[^a-z0-9]+/g, '.') + '@example.invalid' }],
    mapping: { company: 'Company', domain: 'Domain', contact: 'Name', title: 'Title', hq: 'Location', email: 'Email' },
  }));
  assert.equal(imported.createdContacts, 1);
  assert.ok(imported.autoAssigned >= 1, 'spreadsheet import should auto-assign a matching prospect');
  const importedCompany = (await json('/api/companies')).companies.find((c) => c.domain === 'import.' + domainBase);
  assert.ok(importedCompany);
  companyIds.push(importedCompany.id);
  const importedPeople = await json('/api/people?q=' + encodeURIComponent(marker + ' Imported'));
  const importedPerson = importedPeople.people.find((p) => p.name === marker + ' Imported');
  assert.ok(importedPerson);
  project = await json(`/api/projects/${projectId}`);
  assert.ok(project.members.some((p) => p.id === importedPerson.id && p.source === 'auto'));

  const updated = await json(`/api/projects/${projectId}`, send('PUT', {
    name: marker, description: 'Updated context', title_terms: 'No such title', location_terms: 'ProjectTestLand', match_mode: 'all',
  }));
  assert.ok(updated.auto_removed >= 1, 'editing criteria should remove no-longer-matching automatic assignments');
  project = await json(`/api/projects/${projectId}`);
  assert.ok(project.members.some((p) => p.id === autoPerson.id && p.source === 'manual'), 'manual additions survive a rule edit');

  await json(`/api/projects/${projectId}`, { method: 'DELETE' });
  projectId = null;
  const stillThere = await json('/api/people?q=' + encodeURIComponent(marker));
  assert.ok(stillThere.people.length >= 3, 'deleting a project must never delete CRM contacts');
  console.log('PASS custom outreach rules, automatic spreadsheet matching, manual membership control, exclusions, editing and safe project deletion');
} finally {
  if (projectId) await request(`/api/projects/${projectId}`, { method: 'DELETE' });
  const list = await request('/api/companies');
  if (list.ok) {
    const { companies } = await list.json();
    for (const company of companies.filter((c) => c.domain && c.domain.endsWith(domainBase))) {
      await request(`/api/companies/${company.id}`, { method: 'DELETE' });
    }
  }
  await request('/api/logout', { method: 'POST' });
}

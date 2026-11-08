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
async function json(path, options) {
  const response = await request(path, options);
  const data = await response.json();
  assert.ok(response.ok, `${path} failed: ${JSON.stringify(data)}`);
  return data;
}

await json('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: password }) });
const marker = `Segment QA ${Date.now()}`;
let companyId = null;
try {
  const company = await json('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    name: marker, domain: 'segments.invalid', hq: 'Toronto, Canada', country: 'Canada',
    funding: 'Seed funding', funding_stage: 'Seed', open_eng_roles: 'Senior software engineer',
    recent_news: 'QA-only recent hiring announcement', timezone: 'America/Toronto',
  }) });
  companyId = company.id;
  const tech = await json(`/api/companies/${companyId}/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA CTO', title: 'Chief Technology Officer' }) });
  await json(`/api/companies/${companyId}/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Founder', title: 'Co-Founder and CEO' }) });

  const all = await json('/api/people?q=' + encodeURIComponent(marker));
  assert.equal(all.people.length, 2);
  const cto = all.people.find((p) => p.id === tech.id);
  assert.ok(cto);
  assert.equal(cto.role_family, 'technology');
  for (const signal of ['funding', 'hiring', 'news', 'untouched']) assert.ok(cto.signals.includes(signal), `expected ${signal} signal`);
  assert.equal(cto.market_label, 'Canada');
  assert.ok(all.markets.some((m) => m.key === cto.market_key));

  const segment = await json('/api/people?' + new URLSearchParams({ q: marker, market: cto.market_key, role: 'technology', signal: 'hiring' }));
  assert.equal(segment.people.length, 1);
  assert.equal(segment.people[0].id, tech.id);
  const timing = await json('/api/people?' + new URLSearchParams({ q: marker, time: cto.market_time }));
  assert.equal(timing.people.length, 2);
  const founder = await json('/api/people?' + new URLSearchParams({ q: marker, role: 'founder' }));
  assert.equal(founder.people.length, 1);
  assert.equal(founder.people[0].name, 'QA Founder');
  console.log('PASS location, title family, stored-signal and prospect-local-time segmentation');
} finally {
  if (companyId) await request('/api/companies/' + companyId, { method: 'DELETE' });
  await request('/api/logout', { method: 'POST' });
}

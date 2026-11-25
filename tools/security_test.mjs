import assert from 'node:assert/strict';

const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const password = process.env.CRM_TEST_PASSWORD;
assert.ok(password, 'Set CRM_TEST_PASSWORD to the local APP_KEY used by Wrangler');
let cookie = '';
async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  return response;
}

const publicBackup = await fetch(base + '/crm-backup.json');
assert.equal(publicBackup.headers.get('content-type')?.split(';')[0], 'text/html', 'the backup path must not return JSON data');
assert.match(await publicBackup.text(), /<html/i, 'missing static files may fall back to the app shell, but must not expose the backup');
console.log('PASS backup data is not exposed as a JSON static asset');
const appShell = await fetch(base + '/');
assert.match(appShell.headers.get('content-security-policy') || '', /default-src 'self'/);
assert.equal(appShell.headers.get('x-frame-options'), 'DENY');
console.log('PASS static security headers are present');

const who = await request('/api/whoami');
assert.equal(who.status, 200);
assert.equal((await who.json()).authenticated, false);
console.log('PASS unauthenticated status is reported');

const denied = await request('/api/companies');
assert.equal(denied.status, 401, 'protected CRM API must reject anonymous requests');
console.log('PASS CRM data API rejects anonymous requests');

const login = await request('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: password }),
});
assert.equal(login.status, 200);
assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);
assert.match(login.headers.get('set-cookie') || '', /SameSite=Strict/);
assert.doesNotMatch(await login.clone().text(), /"token"\s*:/, 'login must not return a browser-stored bearer secret');
console.log('PASS login issues HttpOnly, SameSite session without returning a token');

const authorized = await request('/api/companies');
assert.equal(authorized.status, 200);
const payload = await authorized.json();
assert.ok(Array.isArray(payload.companies));
console.log('PASS signed session can read CRM data');

const aiStatus = await request('/api/ai/status');
assert.equal(aiStatus.status, 200);
assert.equal((await aiStatus.json()).available, false, 'local mode must not make external AI calls');
const aiDisabled = await request('/api/ai/draft', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: 1 }),
});
assert.equal(aiDisabled.status, 503, 'AI must fail closed when no binding is configured');
console.log('PASS AI is opt-in and disabled in local tests');

const backup = await request('/api/backup');
assert.equal(backup.status, 200);
const backupData = await backup.json();
assert.equal(backupData.version, 9);
assert.ok(Array.isArray(backupData.suppressed_email_hashes), 'backup preserves one-way permanent suppression digests');
assert.ok(Array.isArray(backupData.outreach_projects));
assert.ok(Array.isArray(backupData.project_members));
assert.ok(Array.isArray(backupData.research_notes));
assert.ok(Array.isArray(backupData.replies));
assert.ok(Array.isArray(backupData.enrichment_jobs));
assert.ok(Array.isArray(backupData.provider_usage));
assert.ok(Array.isArray(backupData.copywriting_jobs));
assert.ok(Array.isArray(backupData.email_drafts));
assert.ok(Array.isArray(backupData.emails));
assert.ok(Array.isArray(backupData.email_send_attempts));
assert.ok(Array.isArray(backupData.bounce_events));
assert.ok(Array.isArray(backupData.domain_suppressions));
assert.equal(Object.hasOwn(backupData, 'gmail_connections'), false, 'OAuth tokens and connection secrets are never included in backups');
console.log('PASS authenticated JSON backup includes projects, research, replies, copywriting and email delivery logs, but excludes OAuth tokens');

const logout = await request('/api/logout', { method: 'POST' });
assert.equal(logout.status, 200);
assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
const afterLogout = await request('/api/companies');
assert.equal(afterLogout.status, 401);
console.log('PASS logout revokes browser session');

import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const password = process.env.CRM_TEST_PASSWORD;
assert.ok(password, 'Set CRM_TEST_PASSWORD to the local APP_KEY used by Wrangler');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const excelJs = fs.readFileSync(path.join(root, 'static/vendor/exceljs.min.js'), 'utf8');
const xlsxImporter = fs.readFileSync(path.join(root, 'static/xlsx-import.js'), 'utf8');
const errors = [];
let cookie = '';
const vc = new VirtualConsole();
vc.on('jsdomError', (error) => errors.push(error.stack || error.message));
vc.on('error', (...args) => errors.push(args.join(' ')));
const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
window.fetch = async (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(new URL(String(url), base), { ...options, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  return response;
};
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.confirm = () => true;
window.prompt = () => '';
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.TextDecoder = TextDecoder;
window.eval(excelJs);
window.eval(xlsxImporter);
window.eval(appJs);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(250);
assert.ok(window.document.querySelector('#loginform'), 'unauthenticated visitor should see the login form');
const input = window.document.querySelector('#loginform input[name=key]');
input.value = password;
window.document.querySelector('#loginform').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(900);
assert.ok(!window.document.querySelector('#loginform'), 'successful login should enter the CRM');
assert.equal(typeof window.OrigamiXlsx?.parse, 'function', 'Excel import parser should be loaded');
console.log('PASS login screen, authenticated app boot and XLSX importer');

for (const route of ['#/jarvis', '#/companies', '#/people', '#/projects', '#/research', '#/copywriting', '#/inbox', '#/pipeline', '#/sequences', '#/sequence-health', '#/tasks', '#/analytics', '#/templates', '#/settings']) {
  const startErrors = errors.length;
  window.location.hash = route;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(650);
  const app = window.document.getElementById('app');
  assert.ok(app && app.querySelectorAll('*').length > 2, `${route} should render content`);
  if (route === '#/people') assert.ok(window.document.querySelector('#manualprospect'), 'Prospects route includes manual entry');
  if (route === '#/settings') {
    assert.ok(window.document.querySelector('#icpform') && window.document.querySelector('#quotaform'), 'Settings route includes ICP and quota controls');
    const settingsText = window.document.getElementById('app').textContent;
    assert.match(settingsText, /Prospect data is stored only for B2B outreach purposes/i, 'Settings explains the B2B-only purpose');
    for (const category of ['name', 'company', 'email', 'research notes', 'correspondence']) assert.ok(settingsText.includes(category), `Settings lists the ${category} data category`);
  }
  if (route === '#/copywriting') assert.ok(window.document.querySelector('#run-copywriting'), 'Copywriting route includes the explicit generation action');
  assert.equal(errors.length, startErrors, `${route} should not throw a browser/jsdom error`);
  console.log('PASS route ' + route);
}
window.location.hash = '#/people?role=technology&signal=hiring&time=closed';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
await sleep(650);
assert.equal(window.document.querySelector('#pfilter select[name=role]')?.value, 'technology');
assert.equal(window.document.querySelector('#pfilter select[name=signal]')?.value, 'hiring');
assert.equal(window.document.querySelector('#pfilter select[name=time]')?.value, 'closed');
console.log('PASS shareable segment filters preselect correctly');

const apiHeaders = { 'content-type': 'application/json' };
const fixtureEmail = `copywriting-dom-${Date.now()}@example.test`;
const fixtureCreate = await window.fetch('/api/prospects', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ name: 'Copywriting UI Fixture', email: fixtureEmail, company: 'Copywriting UI Company', domain: `copywriting-dom-${Date.now()}.example.test`, title: 'CTO' }) });
const fixture = await fixtureCreate.json();
assert.equal(fixtureCreate.status, 200, JSON.stringify(fixture));
const fixtureResearch = await window.fetch('/api/research', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ contact_id: fixture.id, source_type: 'website', summary: 'Public notes mention new platform reliability roles and product analytics work.', pain_points: ['Release reliability is a stated focus'], talking_points: ['Platform reliability roles are open', 'The product analytics group is growing'] }) });
assert.equal(fixtureResearch.status, 200);
window.location.hash = '#/contact/' + fixture.id;
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
await sleep(700);
assert.ok(window.document.querySelector('#copywriting'), 'contact page includes the prewritten sequence editor');
assert.ok(window.document.querySelector('#runcopy'), 'queued contact offers an explicit generation action');
console.log('PASS contact copywriting queue and review screen');
await window.fetch(`/api/contacts/${fixture.id}`, { method: 'DELETE' });
await window.fetch(`/api/companies/${fixture.company_id}`, { method: 'DELETE' });

const peopleResponse = await window.fetch('/api/people');
const peopleData = await peopleResponse.json();
if (peopleData.people.length) {
  window.location.hash = '#/contact/' + peopleData.people[0].id;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(650);
  assert.ok(window.document.getElementById('ai-draft'), 'contact composer should include the optional AI draft control');
  assert.ok(window.document.getElementById('linkedinintel'), 'contact detail includes the manual LinkedIn post form');
  assert.ok(window.document.getElementById('enrichment'), 'contact detail shows enrichment progress');
  assert.equal(window.document.getElementById('ai-draft').disabled, true, 'AI control should stay disabled without a configured binding');
  console.log('PASS contact detail + AI control fails closed when AI is not configured');
}
assert.equal(errors.length, 0, errors.join('\n'));
dom.window.close();

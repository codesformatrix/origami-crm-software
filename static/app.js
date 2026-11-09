/* Origami Outreach CRM - front end (vanilla JS, talks to /api/*) */
'use strict';

const appEl = document.getElementById('app');
let AUTH_REQUIRED = true;
let AUTH_CONFIGURED = false;
let USER_TZ = '';
const STATUSES = ['new','active','replied','meeting','proposal','won','lost','passed','paused'];
const CHANNELS = ['email','linkedin','whatsapp','call','other'];

/* ------------------------------------------------------------- plumbing */
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const tk = localStorage.getItem('ocrm_token');
  if (tk) headers['Authorization'] = 'Bearer ' + tk;
  const res = await fetch('/api/' + path, Object.assign({}, opts, { headers: headers }));
  if (res.status === 401) {
    if (path !== 'login') renderLogin('Session expired — enter the password again.');
    throw new Error(path === 'login' ? 'wrong password' : 'unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.indexOf('json') >= 0 ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) ? data.error : ('HTTP ' + res.status));
  return data;
}
const get = (p) => api(p);
const post = (p, b, h) => api(p, { method: 'POST', body: JSON.stringify(b || {}), headers: h || {} });
const put  = (p, b) => api(p, { method: 'PUT',  body: JSON.stringify(b || {}) });
const del  = (p)    => api(p, { method: 'DELETE' });

/* RFC4180-ish parser: handles quoted fields, commas inside quotes, CRLF, and tab files. */
function parseDelimited(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const delim = (src.split(/\r?\n/)[0] || '').split('\t').length > (src.split(/\r?\n/)[0] || '').split(',').length ? '\t' : ',';
  let rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] !== undefined ? String(r[i]).trim() : ''; });
    return o;
  });
}
function formObject(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = (typeof v === 'string') ? v.trim() : v; });
  return o;
}
function parseSpreadsheetRows(file) {
  const name = String(file && file.name || '').toLowerCase();
  if (file && file.size > 5 * 1024 * 1024) return Promise.reject(new Error('Files must be 5 MB or smaller.'));
  if (name.endsWith('.xls')) return Promise.reject(new Error('Legacy .xls is not supported. Save it as .xlsx or CSV first.'));
  if (name.endsWith('.xlsx')) {
    if (!window.OrigamiXlsx) return Promise.reject(new Error('Excel reader is not loaded — refresh the page and try again.'));
    return window.OrigamiXlsx.parse(file).then((sheets) => {
      // Google Sheets exports can contain a blank first tab; prefer the largest useful sheet.
      const selected = sheets.slice().sort((a, b) => b.rows.length - a.rows.length)[0] || { name: '', rows: [] };
      return { rows: selected.rows, sheetName: selected.name, sheets };
    });
  }
  return file.text().then((text) => ({ rows: parseDelimited(text), sheetName: '', sheets: [] }));
}
function headerKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '').trim();
}
function download(filename, content, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}
function merge(text, contact, company) {
  if (!text) return '';
  const first = (contact.name || '').split(/\s+/)[0] || 'there';
  const map = {
    first_name: first, full_name: contact.name || '', title: contact.title || '',
    company: company.name || '', sub_niche: company.sub_niche || '',
    what_they_do: company.what_they_do || '', hq: company.hq || '',
    founded: company.founded || '', funding: company.funding || '',
    funding_stage: company.funding_stage || '', total_raised: company.total_raised || '',
    last_funding_date: company.last_funding_date || '', open_eng_roles: company.open_eng_roles || '',
    recent_news: company.recent_news || '', public_appearances: company.public_appearances || '',
    criteria_flags: company.criteria_flags || '', employees: company.employees || '',
    time_in_role: contact.time_in_role || '', previous_roles: contact.previous_roles || '',
    education: contact.education || ''
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
}
function badge(cls, label) { return `<span class="b ${cls}">${esc(label)}</span>`; }
function tzCity(tz) { return tz ? tz.split('/').pop().replace(/_/g, ' ') : ''; }
function localLine(local, tz) {
  if (!local || !tz) return '<span class="muted">timezone unknown</span>';
  return `<span class="mono">${esc(local.time)}</span> <span class="muted">${esc(local.weekday.slice(0, 3))} · ${esc(tzCity(tz))}</span>`;
}
function windowBadge(w) {
  if (!w) return '';
  if (w.reason === 'unknown-timezone') return badge('due', 'timezone unknown');
  if (w.ok) return badge('replied', 'send now');
  const txt = w.reason === 'weekend' ? 'weekend there'
    : w.reason === 'holiday' ? 'public holiday'
    : w.reason === 'unknown-timezone' ? 'timezone unknown'
    : 'opens ' + esc(w.when);
  return badge(w.ok ? 'replied' : (w.reason === 'weekend' || w.reason === 'holiday' ? 'new' : 'due'), txt);
}
function statusBadge(s) { return badge(s, s); }
function dueLabel(c) {
  if (!c.next_action) return 'now';
  return c.next_action;
}
function safeUrl(u) {
  if (!u) return '';
  return (/^https?:\/\//i.test(u) || u.startsWith('mailto:')) ? u : 'https://' + u;
}

/* --------------------------------------------------------------- router */
function currentPath() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const noQuery = h.split('?')[0];
  return noQuery.startsWith('/') ? noQuery : '/' + noQuery;
}
const TITLES = {
  '/jarvis': 'Jarvis', '/tasks': 'Tasks', '/pipeline': 'Pipeline', '/sequences': 'Sequence Builder', '/sequence-health': 'Sequence Health',
  '/people': 'Prospects', '/projects': 'Outreach projects', '/research': 'Research', '/inbox': 'Inbox / Replies', '/companies': 'Companies', '/templates': 'Templates',
  '/analytics': 'Analytics', '/settings': 'Settings', '/copywriting': 'AI copywriting', '/': 'Dashboard', '/schedule': 'Schedule',
};
function setNav(active) {
  document.querySelectorAll('.navitem[data-nav]').forEach((a) => {
    a.classList.toggle('on', a.getAttribute('data-nav') === active);
  });
  const t = document.getElementById('pageTitle');
  if (t) t.textContent = TITLES[active] || 'Origami';
  document.title = (TITLES[active] || 'Origami') + ' · Origami Outreach';
}
async function refreshCounts() {
  try {
    const [p, t, pe, co] = await Promise.all([get('plan'), get('tasks?done=0'), get('people'), get('companies')]);
    const set = (k, v) => { const el = document.querySelector(`[data-count="${k}"]`); if (el) el.textContent = v; };
    set('sendNow', p.totals.sendNow + p.totals.today);
    set('tasks', t.tasks.length);
    set('people', pe.people.length);
    set('companies', co.companies.length);
    const open = pe.people.filter((x) => ['active', 'replied', 'meeting'].indexOf(x.status) >= 0).length;
    set('pipeline', open);
  } catch { /* counts are cosmetic */ }
}

async function route() {
  const path = currentPath();
  const parts = path.split('/').filter(Boolean);
  const head = parts[0] || '';
  setNav('/' + head);
  appEl.innerHTML = '<div class="spin">Loading…</div>';
  try {
    if (!head)                     return renderDashboard();
    if (head === 'jarvis')         return renderJarvis();
    if (head === 'tasks')          return renderTasks();
    if (head === 'pipeline')       return renderPipeline();
    if (head === 'sequences')      return renderSequences();
    if (head === 'sequence-health') return renderSequenceHealth();
    if (head === 'people')         return renderPeople();
    if (head === 'projects')       return parts[1] ? renderProject(parts[1]) : renderProjects();
    if (head === 'research')       return renderResearch();
    if (head === 'copywriting')    return renderCopywriting();
    if (head === 'inbox')          return renderInbox();
    if (head === 'analytics')      return renderAnalytics();
    if (head === 'companies')      return parts[1] ? renderCompany(parts[1]) : renderCompanies();
    if (head === 'contact')        return renderContact(parts[1]);
    if (head === 'schedule')       return renderSchedule();
    if (head === 'templates')      return renderTemplates();
    if (head === 'settings')       return renderSettings();
    appEl.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (e) {
    if (e.message === 'unauthorized') return;   // login screen is already showing
    appEl.innerHTML = `<div class="err"><b>Something went wrong:</b> ${esc(e.message)}</div>
      <p><a class="btn" href="#/">Back to dashboard</a></p>`;
  }
}

/* ------------------------------------------------------------ dashboard */
async function renderDashboard() {
  const d = await get('dashboard');
  const gmail = await get('gmail/status').catch(() => ({ status: 'disconnected', configured: false }));
  const s = d.counts || { overdue:0,due:0,week:0 };
  const o = d.overview || {};
  const statusNames = { new:'New',active:'Active',replied:'Replied',meeting:'Meeting',proposal:'Proposal',won:'Won',lost:'Lost',passed:'Passed',paused:'Paused',unsubscribed:'Unsubscribed',do_not_contact:'Do not contact',bounced:'Bounced' };
  const statusMarkup = (o.prospects_by_status || []).map((x) => `<span class="b ${['new','active','replied','meeting','won','paused','overdue','slate'].includes(x.status)?x.status:'plain'}">${esc(statusNames[x.status] || x.status)} <b>${Number(x.count)||0}</b></span>`).join(' ') || '<span class="muted">No prospects yet</span>';
  const cap = Number(o.daily_cap || 0), sent = Number(o.sends_today || 0), sendPct = cap ? Math.min(100, Math.round(sent*100/cap)) : 0;
  const quotaCards = (o.quotas || []).map((q) => { const pct = q.cap ? Math.min(100,Math.round(q.used*100/q.cap)) : 0; return `<div class="card pad-sm"><div class="row"><b>${esc(q.provider)}</b><span class="sp"></span><span class="mono">${q.used} / ${q.cap}</span></div><div class="bar mt" style="height:7px"><i style="width:${pct}%"></i></div><div class="sub2">${q.configured?'Key configured':'Key not configured'} · daily counter</div></div>`; }).join('');
  const digest = o.digest || { enriched:0,drafted:0,sent:sent,replies:0,errors:[] };
  appEl.innerHTML = `
  <h1>Dashboard</h1>
  <p class="sub">${s.overdue} overdue · ${s.due} due today · ${s.week} in the next 7 days.</p>
  ${gmail.status !== 'connected' ? `<div class="panel" style="border-color:var(--bad);background:#fff7f6"><b>Gmail ${gmail.status === 'reconnect_required' ? 'needs reconnect' : 'not connected'}.</b> Automated sends and thread reply checks are paused. <a href="#/settings">Open Gmail settings →</a>${gmail.last_error ? `<div class="small muted mt">${esc(gmail.last_error)}</div>` : ''}</div>` : `<div class="panel row"><b>Gmail connected</b><span class="muted">${esc(gmail.email_address)}</span><span class="sp"></span><span class="small muted">${(gmail.queue || []).filter((x) => ['scheduled','retry_wait'].includes(x.status)).reduce((n,x)=>n+Number(x.count),0)} scheduled emails</span></div>`}
  <h2>Outreach overview</h2>
  <div class="grid2 mb">
    <div class="panel"><h3 style="margin-top:0">Prospects by status</h3><div class="row" style="gap:8px;flex-wrap:wrap">${statusMarkup}</div><p class="small muted mt">${Number(d.n_con)||0} total contacts</p></div>
    <div class="panel"><h3 style="margin-top:0">Sends today</h3><div class="row"><strong style="font-size:28px">${sent}</strong><span class="muted">of ${cap} daily cap</span><span class="sp"></span><a href="#/settings">Adjust cap</a></div><div class="bar mt" style="height:9px"><i style="width:${sendPct}%"></i></div><p class="small muted mt">Counts successfully sent Gmail sequence messages today (UTC); replied threads remain included.</p></div>
    <div class="panel"><h3 style="margin-top:0">Open / reply rate · last 30 days</h3><div class="row"><strong style="font-size:25px">${Number(o.reply_rate_30d||0).toFixed(1)}%</strong><span class="muted">reply rate · ${Number(o.replied_threads_30d||0)} / ${Number(o.sent_threads_30d||0)} sent threads</span></div><p class="small muted mt">Open rate is unavailable: Gmail readonly metadata does not expose whether recipients opened a message. Reply rate uses metadata from your own sent threads and detected replies.</p></div>
    <div class="panel"><h3 style="margin-top:0">Sequences</h3><div class="row"><span class="b replied">${Number(o.sequences_active)||0} active</span><span class="b paused">${Number(o.sequences_paused)||0} paused</span><span class="sp"></span><a href="#/sequence-health">Sequence health →</a></div><p class="small muted mt">Counts active and paused enrollments.</p></div>
  </div>
  <div class="panel"><div class="row" style="justify-content:space-between"><h3 style="margin:0">API quota meters</h3><a href="#/settings">Manage limits and test keys →</a></div><div class="grid4 mt">${quotaCards || '<span class="muted">Quota usage is not available.</span>'}</div><p class="small muted">D1 counters for Groq, Tavily, Hunter and Apollo; caps are the configured daily limits.</p></div>
  <div class="panel"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Daily digest · ${esc(o.digest?.date || d.today || '')}</h3><span class="small muted">UTC day</span></div><div class="stats mt">${stat(Number(digest.enriched)||0,'Enriched')}${stat(Number(digest.drafted)||0,'Drafted')}${stat(Number(digest.sent)||0,'Sent')}${stat(Number(digest.replies)||0,'Replies','green')}</div>
    ${digest.errors?.length ? `<h4>Errors</h4><div class="scroll"><table><thead><tr><th>When</th><th>Stage</th><th>Failing API</th><th>Error</th></tr></thead><tbody>${digest.errors.map((e)=>`<tr><td class="mono">${esc(e.at||'')}</td><td>${esc(e.source||'')}</td><td><span class="b overdue">${esc(e.api||'API')}</span></td><td>${esc(e.message||'')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted mt">No recorded job, send, or reply-classification errors today.</p>'}
  </div>
  <div class="stats">
    ${stat(d.n_comp,'Companies')}${stat(d.n_con,'Decision makers')}${stat(d.n_msg,'Messages sent')}
    ${stat(d.n_rep,'Replied','green')}${stat(d.n_meet,'Meetings')}${stat(s.overdue,'Overdue','red')}
    ${stat(s.due,'Due today','amber')}${stat(d.n_new,'Not yet touched')}
  </div>
  <h2>Next up</h2>
  <div class="panel tight">${d.due.length ? `
    <div class="scroll"><table><thead><tr><th>When</th><th>Person</th><th>Company</th><th>Email</th><th>Touches</th><th></th></tr></thead><tbody>
    ${d.due.map((r) => `<tr>
      <td>${badge(r.bucket, dueLabel(r))}</td>
      <td><a href="#/contact/${r.id}"><b>${esc(r.name || '(unnamed)')}</b></a><br><span class="muted">${esc(r.title || '')}</span></td>
      <td><a href="#/companies/${r.company_id}">${esc(r.company_name)}</a><br><span class="muted">${esc(r.sub_niche || '')}</span></td>
      <td class="mono">${esc(r.email || '—')}</td>
      <td class="mono">${r.touch_count}</td>
      <td><a class="btn sm" href="#/contact/${r.id}">Open</a></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Nothing due. Add companies or check back tomorrow.</div>'}
  </div>
  <p><a class="btn" href="#/schedule">Open the full schedule →</a></p>
  <h2>Recent activity</h2>
  <div class="panel tight">${d.recent.length ? `
    <div class="scroll"><table><thead><tr><th>Date</th><th>Dir</th><th>Person</th><th>Company</th><th>Subject / note</th></tr></thead><tbody>
    ${d.recent.map((m) => `<tr><td class="mono">${esc(m.sent_at)}</td>
      <td>${m.direction === 'out' ? badge('new','sent') : badge('replied','reply')}</td>
      <td><a href="#/contact/${m.contact_id}">${esc(m.contact_name)}</a></td>
      <td class="muted">${esc(m.company_name)}</td>
      <td>${esc(m.subject || (m.body ? m.body.slice(0,70) : ''))}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No messages logged yet.</div>'}
  </div>`;
}
function stat(n, label, cls) {
  return `<div class="stat${cls ? ' ' + cls : ''}"><div class="n">${n}</div><div class="l">${label}</div></div>`;
}

/* ------------------------------------------------------------ companies */
async function renderCompanies() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const st = params.get('status') || '';
  const data = await get('companies?q=' + encodeURIComponent(q) + '&status=' + encodeURIComponent(st));
  COMPANY_SEL = new Set();
  appEl.innerHTML = `
  <h1>Companies <span class="muted" style="font-size:16px">(${data.companies.length})</span></h1>
  <p class="sub">Add by domain, click in to see decision makers, then the thread.</p>

  <div class="panel">
    <form class="row" id="filter" style="margin-bottom:14px">
      <input name="q" placeholder="Search name, domain or niche…" value="${esc(q)}" style="max-width:300px">
      <select name="status" style="max-width:170px"><option value="">All statuses</option>
        ${STATUSES.map((s) => `<option value="${s}"${s === st ? ' selected' : ''}>${s}</option>`).join('')}</select>
      <button class="btn">Filter</button>
      <div style="flex:1"></div>
      <button type="button" class="btn sm" id="csv">Export CSV</button>
    </form>
    <h3>Add a company (domain is enough)</h3>
    <form id="addco">
      <div class="f">
        <div><label>Company name *</label><input name="name" required placeholder="Jamble"></div>
        <div><label>Domain</label><input name="domain" placeholder="jamble.app"></div>
        <div><label>Website</label><input name="website" placeholder="https://jamble.app"></div>
        <div><label>Sub-niche</label><input name="sub_niche" placeholder="P2P fashion resale"></div>
      </div>
      <div class="f">
        <div><label>HQ</label><input name="hq" placeholder="Atlanta, GA"></div>
        <div><label>Founded</label><input name="founded" placeholder="2022"></div>
        <div><label>Employees</label><input name="employees" placeholder="11"></div>
        <div><label>Funding</label><input name="funding" placeholder="Seed $2.4M — 2024"></div>
      </div>
      <div class="f one"><div><label>What they do / context for writing</label>
        <textarea name="what_they_do" placeholder="Live shopping marketplace for second-hand fashion…"></textarea></div></div>
      <div class="f one"><div><label>Recent news, risks, fit flags</label><textarea name="context" style="min-height:60px"></textarea></div></div>
      <button class="btn pri">Add company</button>
    </form>
  </div>

  <div class="panel tight">${data.companies.length ? `
    <div class="scroll"><table><thead><tr>
      <th style="width:30px"><input type="checkbox" class="cb" id="co-selall" title="Select all visible companies"></th>
      <th>Company</th><th>Domain</th><th>Niche</th><th>HQ</th><th>Founded</th><th>People</th><th>Last touch</th><th>Status</th>
    </tr></thead><tbody>
    ${data.companies.map((r) => `<tr>
      <td><input type="checkbox" class="cb co-selcb" value="${r.id}" aria-label="Select ${esc(r.name)}"></td>
      <td><a href="#/companies/${r.id}"><b>${esc(r.name)}</b></a></td>
      <td class="mono">${r.domain ? `<a href="${esc(safeUrl(r.domain))}" target="_blank" rel="noopener">${esc(r.domain)}</a>` : '—'}</td>
      <td class="muted">${esc(r.sub_niche || '—')}</td>
      <td class="muted">${esc(r.hq || '—')}</td>
      <td class="mono">${esc(r.founded || '—')}</td>
      <td class="mono">${r.n_contacts}</td>
      <td class="mono">${esc(r.last_msg || '—')}</td>
      <td>${statusBadge(r.status)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No companies yet. Add one above or restore a backup.</div>'}
  </div>
  <div id="company-bulk-root"></div>`;

  document.getElementById('filter').onsubmit = (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    const qs = new URLSearchParams();
    if (o.q) qs.set('q', o.q);
    if (o.status) qs.set('status', o.status);
    location.hash = '#/companies' + (qs.toString() ? '?' + qs.toString() : '');
  };
  document.getElementById('csv').onclick = async () => {
    const res = await fetch('/api/export');
    download('outreach_export.csv', await res.blob(), 'text/csv');
  };
  document.getElementById('addco').onsubmit = async (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    if (!o.name) return;
    await post('companies', o);
    toast('Company added');
    location.hash = '#/companies';
    route();
  };
  const coAll = document.getElementById('co-selall');
  if (coAll) coAll.onchange = (e) => {
    document.querySelectorAll('.co-selcb').forEach((c) => { c.checked = e.target.checked; });
    COMPANY_SEL.clear();
    if (e.target.checked) document.querySelectorAll('.co-selcb').forEach((c) => COMPANY_SEL.add(+c.value));
    drawCompanyBulk();
  };
  document.querySelectorAll('.co-selcb').forEach((c) => {
    c.onchange = () => {
      if (c.checked) COMPANY_SEL.add(+c.value); else COMPANY_SEL.delete(+c.value);
      const all = document.getElementById('co-selall');
      if (all) all.checked = COMPANY_SEL.size === document.querySelectorAll('.co-selcb').length;
      drawCompanyBulk();
    };
  });
}

/* --------------------------------------------------------- company page */
async function renderCompany(id) {
  const { company: co, contacts, messages } = await get('companies/' + id);
  appEl.innerHTML = `
  <p class="muted" style="margin-top:18px"><a href="#/companies">← Companies</a></p>
  <div class="grid2"><div>
    <h1>${esc(co.name)}</h1>
    <p class="sub">
      ${co.domain ? `<a href="${esc(safeUrl(co.domain))}" target="_blank" rel="noopener">${esc(co.domain)}</a> · ` : ''}
      ${esc(co.hq || 'HQ unknown')} · founded ${esc(co.founded || '?')} · ${esc(co.employees || '?')} people
      &nbsp;${statusBadge(co.status)}
    </p>

    <div class="panel"><h3>Context (never re-research this again)</h3>
      <div class="ctx">${co.what_they_do ? nl2br(co.what_they_do) : '<span class="muted">Nothing written yet.</span>'}</div></div>
    ${co.context ? `<div class="panel"><h3>Notes / news / risks</h3><div class="ctx">${nl2br(co.context)}</div></div>` : ''}

    <h2>Decision makers</h2>
    <div class="panel tight">${contacts.length ? `
      <div class="scroll"><table><thead><tr><th>Person</th><th>Title</th><th>Email</th><th>Status</th><th>Next</th><th></th></tr></thead><tbody>
      ${contacts.map((c) => `<tr>
        <td><a href="#/contact/${c.id}"><b>${esc(c.name || '(unnamed)')}</b></a>
          ${c.linkedin ? `<br><a class="muted" href="${esc(safeUrl(c.linkedin))}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</td>
        <td class="muted">${esc(c.title || '—')}</td>
        <td class="mono">${esc(c.email || '—')}</td>
        <td>${statusBadge(c.status)}</td>
        <td class="mono">${esc(c.next_action || '—')}<br><span class="muted">${c.touch_count} touches</span></td>
        <td><a class="btn sm" href="#/contact/${c.id}">Open →</a></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No decision makers yet. Add the founder below.</div>'}
    </div>

    <div class="panel"><h3>Add a decision maker</h3>
      <form id="addct">
        <div class="f">
          <div><label>Name</label><input name="name" placeholder="Jane Doe"></div>
          <div><label>Title</label><input name="title" placeholder="Co-Founder & CEO"></div>
          <div><label>Email</label><input name="email" placeholder="jane@…"></div>
        </div>
        <div class="f">
          <div><label>Phone / WhatsApp</label><input name="phone"></div>
          <div><label>LinkedIn URL</label><input name="linkedin"></div>
          <div><label>Follow-up cadence (days)</label><input type="number" name="cadence" value="${co.cadence || 4}" min="1" max="30"></div>
        </div>
        <div class="f">
          <div><label>Time in role</label><input name="time_in_role"></div>
          <div><label>Previous roles</label><input name="previous_roles"></div>
          <div><label>Education</label><input name="education"></div>
        </div>
        <div class="f one"><div><label>Notes</label><textarea name="notes" style="min-height:58px"></textarea></div></div>
        <button class="btn pri">Add person</button>
      </form>
    </div>
  </div><div>
    <div class="panel"><h3>Company detail</h3><dl class="kv">
      <dt>Sub-niche</dt><dd>${esc(co.sub_niche || '—')}</dd>
      <dt>Funding</dt><dd>${esc(co.funding || '—')}</dd>
      <dt>Funding stage</dt><dd>${esc(co.funding_stage || '—')}</dd>
      <dt>Total raised</dt><dd>${esc(co.total_raised || '—')}</dd>
      <dt>Last funding</dt><dd>${esc(co.last_funding_date || '—')}</dd>
      <dt>Website</dt><dd>${co.website ? `<a href="${esc(safeUrl(co.website))}" target="_blank" rel="noopener">${esc(co.website)}</a>` : '—'}</dd>
      <dt>LinkedIn</dt><dd>${co.linkedin ? `<a href="${esc(safeUrl(co.linkedin))}" target="_blank" rel="noopener">page</a>` : '—'}</dd>
      <dt>Source</dt><dd>${esc(co.source || 'manual')}</dd>
      <dt>Added</dt><dd>${esc(co.created_at || '')}</dd>
    </dl>
    <h3 style="margin-top:16px">Location &amp; timing</h3>
    <dl class="kv">
      <dt>Detected city</dt><dd>${esc(co.city || '—')}</dd>
      <dt>Country</dt><dd>${esc(co.country || '—')}</dd>
      <dt>Timezone</dt><dd>${co.timezone ? `<span class="mono">${esc(co.timezone)}</span>` : '<span class="muted">not detected</span>'}</dd>
    </dl>
    <form id="tzform" style="margin-top:10px">
      <div class="f one"><div><label>Override timezone (IANA, e.g. Europe/Berlin)</label>
        <input name="timezone" value="${esc(co.timezone || '')}" placeholder="Europe/Berlin"></div></div>
      <div class="row">
        <button class="btn">Save</button>
        <button type="button" class="btn" id="redetect">Re-detect from HQ</button>
        <span class="muted" id="tzmsg"></span>
      </div>
    </form>
    <p class="muted" style="margin-top:8px">Follow-ups for this company skip weekends and public holidays
      in their country, and land on their working days.</p>
  </div>

    ${(co.open_eng_roles || co.recent_news || co.public_appearances || co.criteria_flags) ? `<div class="panel"><h3>Research signals</h3>
      ${co.open_eng_roles ? `<p><b>Open engineering roles</b><br>${nl2br(co.open_eng_roles)}</p>` : ''}
      ${co.recent_news ? `<p><b>Recent news</b><br>${nl2br(co.recent_news)}</p>` : ''}
      ${co.public_appearances ? `<p><b>Public appearances</b><br>${nl2br(co.public_appearances)}</p>` : ''}
      ${co.criteria_flags ? `<p><b>Flags / criteria check</b><br>${nl2br(co.criteria_flags)}</p>` : ''}
    </div>` : ''}

    <div class="panel"><h3>Edit company</h3><form id="editco">
      <div class="f one">
        <div><label>Name</label><input name="name" value="${esc(co.name)}"></div>
        <div><label>Domain</label><input name="domain" value="${esc(co.domain || '')}"></div></div>
      <div class="f">
        <div><label>HQ</label><input name="hq" value="${esc(co.hq || '')}"></div>
        <div><label>Founded</label><input name="founded" value="${esc(co.founded || '')}"></div>
        <div><label>Employees</label><input name="employees" value="${esc(co.employees || '')}"></div>
        <div><label>Funding</label><input name="funding" value="${esc(co.funding || '')}"></div>
        <div><label>Funding stage</label><input name="funding_stage" value="${esc(co.funding_stage || '')}"></div>
        <div><label>Total raised</label><input name="total_raised" value="${esc(co.total_raised || '')}"></div>
        <div><label>Last funding date</label><input name="last_funding_date" value="${esc(co.last_funding_date || '')}"></div>
        <div><label>Sub-niche</label><input name="sub_niche" value="${esc(co.sub_niche || '')}"></div>
        <div><label>Status</label><select name="status">${STATUSES.map((s) => `<option value="${s}"${s === co.status ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="f one"><div><label>What they do</label><textarea name="what_they_do">${esc(co.what_they_do || '')}</textarea></div></div>
      <div class="f one"><div><label>Notes / news / risks</label><textarea name="context" style="min-height:70px">${esc(co.context || '')}</textarea></div></div>
      <div class="f one"><div><label>Open engineering roles</label><textarea name="open_eng_roles" style="min-height:55px">${esc(co.open_eng_roles || '')}</textarea></div></div>
      <div class="f one"><div><label>Recent news</label><textarea name="recent_news" style="min-height:55px">${esc(co.recent_news || '')}</textarea></div></div>
      <div class="f one"><div><label>Public appearances</label><textarea name="public_appearances" style="min-height:55px">${esc(co.public_appearances || '')}</textarea></div></div>
      <div class="f one"><div><label>Flags / criteria check</label><textarea name="criteria_flags" style="min-height:55px">${esc(co.criteria_flags || '')}</textarea></div></div>
      <div class="f one"><div><label>Default follow-up cadence (days)</label><input type="number" name="cadence" value="${co.cadence || 4}" min="1" max="30"></div></div>
      <input type="hidden" name="timezone" value="${esc(co.timezone || '')}">
      <div class="row"><button class="btn pri">Save</button></div>
    </form></div>

    <div class="panel"><h3>Activity at this company</h3>
      <p class="sub small" style="margin-top:0">Everything that happened with anyone here — sends, replies,
        tracked clicks, unsubscribe requests, tasks.</p>
      <div id="cotl">${timelineHtml(messages.map((m) => ({
        kind: m.direction === 'out' ? 'sent' : 'reply', at: m.sent_at, who: m.contact_name,
        text: (m.subject || '') + (m.body ? ' — ' + m.body.slice(0, 120) : ''), channel: m.channel,
      })))}</div>
    </div>
    <button class="btn gh sm" id="delco">Delete company</button>
  </div></div>`;

  document.getElementById('addct').onsubmit = async (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    await post('companies/' + id + '/contacts', o);
    toast('Decision maker added');
    route();
  };
  document.getElementById('editco').onsubmit = async (e) => {
    e.preventDefault();
    await put('companies/' + id, formObject(e.target));
    toast('Saved');
    route();
  };
  const tzf = document.getElementById('tzform');
  if (tzf) tzf.onsubmit = async (e) => {
    e.preventDefault();
    await put('companies/' + id, formObject(e.target));
    toast('Timezone saved'); route();
  };
  const rd = document.getElementById('redetect');
  if (rd) rd.onclick = async () => {
    const det = await post('detect', { hq: co.hq });
    const msg = document.getElementById('tzmsg');
    if (!det.timezone) { msg.textContent = 'could not detect — set it manually'; return; }
    await put('companies/' + id, { timezone: det.timezone });
    msg.textContent = det.timezone + ' (' + det.confidence + ') · now ' + det.localTime + ' there';
    toast('Detected ' + det.timezone);
    setTimeout(route, 600);
  };

  document.getElementById('delco').onclick = async () => {
    if (!confirm('Delete ' + co.name + ' and all its people and messages?')) return;
    await del('companies/' + id);
    location.hash = '#/companies';
    route();
  };

  // enrich the panel with clicks / opt-outs / tasks, which the plain message list can't see
  try {
    const t = await get('companies/' + id + '/timeline');
    const box = document.getElementById('cotl');
    if (box && t.timeline.length) box.innerHTML = timelineHtml(t.timeline);
  } catch { /* timeline is additive - never block the page on it */ }
}

const TL_ICON = { sent: '↗', reply: '↙', click: '🔗', optout: '⛔', open: '👁', task: '☑', task_done: '✅' };
const TL_TEXT = { sent: 'sent', reply: 'replied', click: 'clicked a tracked link', optout: 'unsubscribed', open: 'open (unreliable)' };
function timelineHtml(items) {
  if (!items || !items.length) return '<div class="muted small">Nothing logged yet.</div>';
  return items.slice(0, 40).map((it) => `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #F0F1F4">
      <div style="width:20px;text-align:center;color:var(--muted)">${TL_ICON[it.kind] || '•'}</div>
      <div style="flex:1;min-width:0">
        <div><b>${esc(it.who || 'Company')}</b> <span class="muted">${esc(TL_TEXT[it.kind] || it.kind)}</span>
          ${it.channel ? `<span class="b plain">${esc(it.channel)}</span>` : ''}</div>
        <div class="sub2">${esc(it.text || '')}</div>
      </div>
      <div class="mono muted small" style="white-space:nowrap">${esc(String(it.at || '').slice(0, 10))}</div>
    </div>`).join('');
}

/* --------------------------------------------------------- contact page */
async function renderContact(id) {
  const [d, sequenceData] = await Promise.all([get('contacts/' + id), get('sequences').catch(() => ({ sequences: [] }))]);
  const availableSequences = sequenceData.sequences || [];
  const c = d.contact, co = d.company;
  let planItem = null;
  try {
    const p = await get('plan');
    for (const k of ['sendNow', 'today', 'later']) {
      const f = (p[k] || []).find((x) => x.contact.id === c.id);
      if (f) { planItem = f; break; }
    }
  } catch { /* plan is a nice-to-have here */ }
  const researchNotesHtml = (d.research_notes || []).map((note) => {
    let pains = [], points = [];
    try { pains = JSON.parse(note.pain_points || '[]'); } catch {}
    try { points = JSON.parse(note.talking_points || '[]'); } catch {}
    return `<div class="card pad-sm mb" style="box-shadow:none"><div class="row"><b>${esc(note.source_type === 'linkedin_manual' ? 'Manually supplied LinkedIn intel' : 'Public research synthesis')}</b><span class="sp"></span>${note.icp_score !== null && note.icp_score !== undefined ? `<span class="b plain">ICP ${note.icp_score}/100</span>` : ''}</div>
      <div class="small muted">${esc(note.fetched_at || '')}${note.icp_reason ? ' · ' + esc(note.icp_reason) : ''}</div><p>${nl2br(note.summary || '')}</p>
      <div class="grid2"><div><b>Pain points</b><ul>${pains.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div><div><b>Talking points</b><ul>${points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div></div>`;
  }).join('');
  const copyDrafts = d.email_drafts || [];
  const allCopyDraftsReady = copyDrafts.length === 4 && copyDrafts.every((x) => Number(x.personalization_score) >= 70 && Number(x.constraints_valid) === 1);
  const copywritingPanel = `<div class="panel" id="copywriting"><div class="row"><h3 style="margin:0">Prewritten email sequence</h3><span class="sp"></span>${d.copywriting ? badge(d.copywriting.status === 'ready' ? 'replied' : d.copywriting.status === 'needs_review' ? 'due' : 'plain', esc(d.copywriting.status)) : ''}</div>
    <p class="small muted">AI-generated drafts based on saved research. Review and edit every email. Each email is automatically rewritten with the latest research 6 to 12 hours before it sends — paste new posts or news into the research panel anytime and the pre-send refresh picks them up. Nothing sends until you connect Gmail and explicitly schedule the sequence.</p>
    ${d.copywriting ? `<p class="small muted">${esc(d.copywriting.detail || '')}${d.copywriting.error ? ` · ${esc(d.copywriting.error)}` : ''}</p>` : ''}
    ${!copyDrafts.length ? `<div class="row">${!d.copywriting || ['needs_configuration','failed','completed'].includes(d.copywriting.status) ? `<button class="btn sm" id="queuecopy">Queue four drafts</button>` : ''}${d.copywriting?.status === 'queued' ? `<button class="btn pri sm" id="runcopy">Generate now</button>` : ''}<span id="copywritingmsg" class="small muted"></span></div>` : ''}
    ${copyDrafts.map((draft) => { let breakdown = {}; try { breakdown = JSON.parse(draft.score_breakdown || '{}'); } catch {} return `<form class="card pad-sm mb copy-draft" data-draft-id="${draft.id}" style="box-shadow:none"><div class="row"><b>Email ${draft.step_number}${draft.step_number === 4 ? ' · breakup' : ''}</b><span class="sp"></span>${badge(Number(draft.personalization_score) >= 70 && Number(draft.constraints_valid) === 1 ? 'replied' : 'due', `Score ${draft.personalization_score ?? 'not scored'}/100`)}</div>
      <div class="f one"><div><label>Subject${draft.step_number > 1 ? ' · shared Gmail thread subject' : ''}</label><input name="subject" maxlength="160" value="${esc(draft.subject || '')}" ${draft.status === 'sent' || draft.step_number > 1 ? 'disabled' : ''}></div></div>
      <div class="f one"><div><label>Email body</label><textarea name="body" rows="6" maxlength="8000" ${draft.status === 'sent' ? 'disabled' : ''}>${esc(draft.body || '')}</textarea></div></div>
      <div class="small muted">${Number(draft.word_count || 0)} words · ${draft.constraints_valid ? 'copy rules pass' : 'copy rules need attention'}${draft.is_user_edited ? ' · edited' : ''}</div>
      ${draft.score_critique ? `<p class="small" style="margin:6px 0">${esc(draft.score_critique)}</p>` : ''}
      <details class="small muted"><summary>Score breakdown</summary><p>Personalization ${breakdown.personalization_depth ?? '—'} · CTA ${breakdown.cta_clarity ?? '—'} · Subject ${breakdown.subject_line_strength ?? '—'} · Spam safety ${breakdown.spam_safety ?? '—'}</p></details>
      <div class="row mt">${draft.status === 'sent' ? '<span class="small muted">Logged as sent. This draft is locked.</span>' : '<button class="btn sm" type="submit">Save and rescore</button>'}<span class="small muted" data-draft-message></span></div></form>`; }).join('')}
    ${copyDrafts.length === 4 && d.copywriting?.status !== 'sent' ? `<div class="f"><div><label>Sequence cadence</label><select id="copy-sequence" ${d.copywriting?.status === 'scheduled' ? 'disabled' : ''}><option value="" ${!d.copywriting?.sequence_id && !d.active_enrollment ? 'selected' : ''}>Default · 3, 4, 5 business days</option>${availableSequences.map((sq)=>{const activeRows=sq.steps.filter(st=>st.active===undefined||Number(st.active)!==0);const activeSteps=activeRows.length;const emailReady=[1,2,3,4].every(n=>activeRows.some(st=>Number(st.step_order)===n&&String(st.channel).toLowerCase()==='email'));return `<option value="${sq.id}" ${(Number(d.copywriting?.sequence_id || d.active_enrollment?.sequence_id)===Number(sq.id))?'selected':''} ${!sq.active||!emailReady?'disabled':''}>${esc(sq.name)} · ${activeSteps} active steps${emailReady?'':' · needs four email steps'}${sq.active?'':' · paused'}</option>`}).join('')}</select></div></div><div class="row"><button class="btn pri" id="schedulecopy" ${allCopyDraftsReady && d.gmail?.status === 'connected' && !['scheduled','paused_auth','paused_reply','paused_domain','paused_sequence','paused_config','paused_timezone','suppressed','bounced','cancelled'].includes(d.copywriting?.status) ? '' : 'disabled'}>${d.copywriting?.status === 'scheduled' ? 'Scheduled for Gmail' : 'Schedule automatic sequence'}</button><span class="small muted">${d.copywriting?.status === 'paused_auth' ? 'Sending is paused. Reconnect Gmail, then resume paused sends in Settings.' : d.copywriting?.status === 'paused_reply' ? 'A reply was detected. This prospect’s follow-ups are paused.' : allCopyDraftsReady ? (d.gmail?.status === 'connected' ? 'Step 1 is day 0. Follow-ups use business-day delays and the 9 to 11 local window, Monday through Thursday.' : 'Connect Gmail in Settings before scheduling automatic delivery.') : 'Every draft must score at least 70 and pass the copy rules.'}</span></div>` : ''}
  </div>`;

  appEl.innerHTML = `
  <p class="muted" style="margin-top:18px"><a href="#/companies/${co.id}">← ${esc(co.name)}</a></p>
  <div class="grid2"><div>
    <h1>${esc(c.name || '(unnamed)')}</h1>
    <p class="sub">${esc(c.title || 'title unknown')} at <a href="#/companies/${co.id}">${esc(co.name)}</a>
      · ${statusBadge(c.status)} · ${c.touch_count} touch${c.touch_count === 1 ? '' : 'es'}
      ${c.last_touch ? '· last ' + esc(c.last_touch) : ''}</p>

    <p class="muted" style="margin:-6px 0 12px">
      ${c.timezone || co.timezone
        ? `Their time: <b>${planItem && planItem.local ? esc(planItem.local.weekday + ' ' + planItem.local.time) : esc(c.timezone || co.timezone)}</b>
           <span class="muted">· ${esc(tzCity(c.timezone || co.timezone))}${c.country || co.country ? ', ' + esc(c.country || co.country) : ''}</span>
           ${windowBadge(planItem && planItem.window)}`
        : '<span class="muted">No timezone detected — the AI will detect it automatically from research, or you can detect it now.</span> ' + `<button class="btn sm" id="detecttz">Detect timezone now</button>`}
    </p>

    <div class="row" style="margin-bottom:18px">
      ${c.next_action ? badge(d.bucket, d.bucket === 'due' ? 'Follow up today'
          : d.bucket === 'overdue' ? 'Overdue since ' + c.next_action : 'Next: ' + c.next_action) : ''}
      <button class="btn sm" data-snooze="3">Snooze 3d</button>
      <button class="btn sm" data-snooze="5">Snooze 5d</button>
      <button class="btn sm" data-snooze="7">Snooze 7d</button>
    </div>

    <div class="panel" id="enrichment"><h3>Enrichment</h3>
      <p class="muted" style="margin-top:0">${d.enrichment ? `<b>${esc(d.enrichment.status)}</b> · ${esc(d.enrichment.stage)} · ${Number(d.enrichment.progress || 0)}% — ${esc(d.enrichment.detail || '')}` : 'Not queued yet.'}</p>
      ${d.enrichment ? `<div class="bar" style="height:7px"><i style="width:${Math.max(0,Math.min(100,d.enrichment.progress || 0))}%"></i></div>` : ''}
      ${(!d.enrichment || ['needs_configuration','failed','completed'].includes(d.enrichment?.status)) ? '<button class="btn sm mt" id="queueprospect">Queue / retry enrichment</button>' : ''}
      <p class="small muted">Company research uses public homepage/about/blog pages and public search. No LinkedIn URL is ever fetched.</p>
    </div>
    <div class="panel"><h3>Timezone detection</h3>
      <p class="muted" style="margin-top:0">${d.timezone_job ? `<b>${esc(d.timezone_job.status)}</b> · ${esc(d.timezone_job.detail || d.timezone_job.error || 'queued for detection')}${d.timezone_job.finished_at ? ' · ' + esc(d.timezone_job.finished_at) : ''}` : (c.timezone ? '<b>set</b> · ' + esc(c.timezone) : '<span class="muted">Not queued yet.</span>')}${c.timezone ? ' ' + `<button class="btn sm" id="detecttz2">Re-detect</button>` : ''}</p>
      <p class="small muted">Detection uses uploaded data first, then AI inference, then deep web research of the company website and search results. The detected timezone sets outreach windows and gives the email AI local context.</p>
    </div>

    <div class="panel"><h3>LinkedIn post intel — manual input only</h3>
      <p class="small muted" style="margin-top:0">Paste post text, or a public post URL. URLs are never opened or scraped; URL-only input may use public search snippets and will ask for pasted text if none are indexed.</p>
      <form id="linkedinintel">
        <div class="f one"><div><label>LinkedIn post URL (optional)</label><input name="url" placeholder="https://www.linkedin.com/posts/…"></div></div>
        <div class="f one"><div><label>Post text (recommended)</label><textarea name="text" rows="5" maxlength="12000" placeholder="Paste the LinkedIn post text here…"></textarea></div></div>
        <button class="btn pri">Synthesize and save manual intel</button><span class="small muted" id="linkedinmsg"></span>
      </form>
    </div>
    ${researchNotesHtml ? `<div class="panel"><h3>Research notes</h3>${researchNotesHtml}</div>` : ''}
    ${copywritingPanel}

    <div class="panel"><h3>Send / log a message</h3>
      ${planItem && planItem.draft
        ? `<p class="muted" style="margin-top:0">Jarvis suggests <b>${esc(planItem.draft.templateName)}</b>
           (${esc(planItem.draft.channel)}) for touch ${planItem.touch + 1}${planItem.reason ? ' — ' + esc(planItem.reason) : ''}.
           Next follow-up will be scheduled +${planItem.nextCadence} days on their calendar.</p>`
        : ''}
      <form id="compose">
        <input type="hidden" name="email_draft_id" id="email-draft-id" value="">
        <div class="f">
          <div><label>Channel</label><select name="channel">${CHANNELS.map((x) => `<option value="${x}">${x}</option>`).join('')}</select></div>
          <div><label>Template</label><select id="tpl">
            <option value="">— write from scratch —</option>
            ${d.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
        </div>
        <div class="f one"><div><label>Subject</label><input name="subject" id="subject" placeholder="quick one on ${esc(co.name)}"></div></div>
        <div class="f one"><div><label>Message</label><textarea name="body" id="body" style="min-height:170px" placeholder="Paste what you actually sent…"></textarea></div></div>
        <div class="f">
          <div><label>AI draft goal (optional)</label><input id="ai-goal" maxlength="500" placeholder="e.g. ask whether a discovery call would be useful"></div>
          <div><label>AI tone</label><select id="ai-tone"><option value="professional">Professional</option><option value="warm">Warm</option><option value="direct">Direct</option></select></div>
        </div>
        <p class="small muted">AI uses selected contact/company fields via the configured server-side provider fallback. Verify every fact and edit the draft; it never sends. <span id="ai-notice"></span></p>
        <div class="row">
          <button class="btn" type="button" id="ai-draft">Draft with AI</button>
          <button class="btn pri" type="submit">Log as sent → schedules next follow-up in ${c.cadence || 4} days</button>
          <button type="button" class="btn" id="copy">Copy to clipboard</button>
          <span class="muted" id="copied"></span>
        </div>
      </form>
    </div>

    <div class="panel"><h3>Log a reply</h3>
      <form id="replyform">
        <div class="f">
          <div><label>Channel</label><select name="channel">${CHANNELS.map((x) => `<option value="${x}">${x}</option>`).join('')}</select></div>
          <div><label>Subject</label><input name="subject" placeholder="Re: …"></div>
        </div>
        <div class="f one"><div><label>What they said</label><textarea name="body" style="min-height:90px"></textarea></div></div>
        <button class="btn ok">Log reply — marks them replied</button>
      </form>
    </div>

    <h2>Thread</h2>
    ${d.messages.length ? d.messages.map((m) => `
      <div class="msg ${m.direction}">
        <div class="hd">${m.direction === 'in' ? badge('replied','reply') : badge('new','sent')}
          <b>${esc(m.channel)}</b> · ${esc(m.sent_at)}</div>
        ${m.subject ? `<div class="st">${esc(m.subject)}</div>` : ''}
        <div class="wh">${esc(m.body || '')}</div></div>`).join('')
      : '<div class="empty">No messages yet for this person.</div>'}
  </div><div>
    <div class="panel"><h3>Contact details</h3><dl class="kv">
      <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>
        <button class="btn xs" id="verifyemail" style="margin-left:6px">Verify</button>
        <span id="verifyresult" class="small"></span>` : `<span class="muted">not added</span>${c.email_discovery_status === 'needs_manual_email' ? ' · <b>needs manual email</b>' : ''}`}</dd>
      <dt>Phone / WA</dt><dd>${esc(c.phone || '—')}</dd>
      <dt>LinkedIn</dt><dd>${c.linkedin ? `<a href="${esc(safeUrl(c.linkedin))}" target="_blank" rel="noopener">open profile</a>` : '—'}</dd>
      <dt>Time in role</dt><dd>${esc(c.time_in_role || '—')}</dd>
      <dt>Previous roles</dt><dd>${esc(c.previous_roles || '—')}</dd>
      <dt>Education</dt><dd>${esc(c.education || '—')}</dd>
      <dt>Cadence</dt><dd>every ${c.cadence || 4} days</dd>
      <dt>Next action</dt><dd>${esc(c.next_action || '—')}</dd>
    </dl></div>

    <div class="panel"><h3>Company context</h3>
      <div class="ctx">${co.what_they_do ? nl2br(co.what_they_do) : '—'}</div>
      <dl class="kv" style="margin-top:12px">
        <dt>Niche</dt><dd>${esc(co.sub_niche || '—')}</dd>
        <dt>HQ</dt><dd>${esc(co.hq || '—')}</dd>
        <dt>Funding</dt><dd>${esc(co.funding || '—')}</dd>
        <dt>Headcount</dt><dd>${esc(co.employees || '—')}</dd>
        <dt>Founded</dt><dd>${esc(co.founded || '—')}</dd>
        <dt>Live product</dt><dd>${esc(co.live_product || '—')}</dd>
        <dt>Founders</dt><dd>${esc(co.founders || '—')}</dd>
        <dt>Technical lead</dt><dd>${esc(co.technical_lead || '—')}</dd>
      </dl></div>

    <div class="panel"><h3>Update status</h3><form id="statusform">
      <div class="f">
        <div><label>Status</label><select name="status">${STATUSES.map((s) => `<option value="${s}"${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Next action date</label><input type="date" name="next_action" value="${esc(c.next_action || '')}"></div>
      </div>
      <div class="f one"><div><label>Cadence (days between follow-ups)</label><input type="number" name="cadence" value="${c.cadence || 4}" min="1" max="30"></div></div>
      <button class="btn pri">Save</button>
      <p class="muted" style="margin-top:8px">Set to won / passed / paused to clear the follow-up queue.</p>
    </form></div>

    <div class="panel"><h3>Edit person</h3><form id="editct">
      <div class="f one">
        <div><label>Name</label><input name="name" value="${esc(c.name || '')}"></div>
        <div><label>Title</label><input name="title" value="${esc(c.title || '')}"></div></div>
      <div class="f one">
        <div><label>Email</label><input name="email" value="${esc(c.email || '')}"></div>
        <div><label>Phone</label><input name="phone" value="${esc(c.phone || '')}"></div>
        <div><label>LinkedIn</label><input name="linkedin" value="${esc(c.linkedin || '')}"></div></div>
      <div class="f">
        <div><label>Time in role</label><input name="time_in_role" value="${esc(c.time_in_role || '')}"></div>
        <div><label>Previous roles</label><input name="previous_roles" value="${esc(c.previous_roles || '')}"></div>
        <div><label>Education</label><input name="education" value="${esc(c.education || '')}"></div>
        <div><label>Prospect timezone (IANA, optional)</label><input name="timezone" value="${esc(c.timezone || '')}" placeholder="America/New_York"></div>
      </div>
      <div class="f one"><div><label>B2B outreach notes only (no sensitive personal data)</label><textarea name="notes" style="min-height:60px">${esc(c.notes || '')}</textarea></div></div>
      <div class="row"><button class="btn pri">Save</button></div>
    </form></div>

    <div class="panel"><h3>Privacy, consent &amp; opt-out history</h3>
      <p class="small muted">Use this log for explicit consent evidence where applicable. Legitimate-interest B2B outreach does not itself imply consent. A recorded grant never overrides a previous unsubscribe or permanent suppression.</p>
      <form id="consentform"><div class="f"><div><label>Event</label><select name="action"><option value="granted">Record explicit consent</option><option value="withdrawn">Record withdrawal</option></select></div><div><label>Channel</label><select name="channel"><option value="email">Email</option><option value="phone">Phone</option><option value="other">Other</option></select></div></div><div class="f one"><div><label>Evidence / source (date, form, conversation reference)</label><input name="source" maxlength="200" placeholder="e.g. consent form dated YYYY-MM-DD"></div></div><button class="btn sm">Save consent event</button></form>
      <div class="mt small">${(d.compliance_events || []).length ? d.compliance_events.map((event) => `<div class="card pad-sm mb" style="box-shadow:none"><b>${esc(event.type)}</b> · ${esc(event.created_at)}<div>${esc(event.detail || '')}</div></div>`).join('') : '<span class="muted">No consent or opt-out events logged.</span>'}</div>
    </div>

    ${d.others.length ? `<div class="panel"><h3>Others at ${esc(co.name)}</h3>
      ${d.others.map((o) => `<div style="margin-bottom:6px"><a href="#/contact/${o.id}">${esc(o.name)}</a>
        <span class="muted">· ${esc(o.title || '')}</span></div>`).join('')}</div>` : ''}
    <div class="panel" style="border-color:var(--bad)"><h3>Erase prospect data</h3><p class="small muted">Permanently removes this person’s contact details, research, messages, drafts, replies, tracking tokens, tasks, project memberships, and contact-linked logs. An anonymous erasure audit entry remains. If this person opted out, a one-way suppression digest remains so the address cannot be re-added for outreach.</p><button class="btn gh sm" id="delct">Delete all data</button></div>
  </div></div>`;

  const queueCopy = document.getElementById('queuecopy');
  if (queueCopy) queueCopy.onclick = async () => { queueCopy.disabled = true; try { await post(`contacts/${id}/copywriting/queue`, {}); toast('Copywriting queued'); route(); } catch (err) { toast(err.message); queueCopy.disabled = false; } };
  const runCopy = document.getElementById('runcopy');
  if (runCopy) runCopy.onclick = async () => { runCopy.disabled = true; runCopy.textContent = 'Generating…'; try { await post('copywriting/run', {}); toast('Copywriting finished'); route(); } catch (err) { toast(err.message); runCopy.disabled = false; } };
  appEl.querySelectorAll('.copy-draft').forEach((form) => { form.onsubmit = async (e) => { e.preventDefault(); const button = form.querySelector('button[type=submit]'); const msg = form.querySelector('[data-draft-message]'); button.disabled = true; msg.textContent = 'Saving and rescoring…'; try { await put('email-drafts/' + form.dataset.draftId, formObject(form)); toast('Draft saved and rescored'); route(); } catch (err) { msg.textContent = err.message; button.disabled = false; } }; });
  const scheduleCopy = document.getElementById('schedulecopy');
  if (scheduleCopy && !scheduleCopy.disabled && d.copywriting?.status !== 'scheduled') scheduleCopy.onclick = async () => { scheduleCopy.disabled = true; const sequenceId=Number(document.getElementById('copy-sequence')?.value)||null; try { await post(`contacts/${id}/copywriting/schedule`, { sequence_id:sequenceId, use_default:!sequenceId }); toast('Sequence added to the Gmail queue with business-day scheduling.'); route(); } catch (err) { toast(err.message); scheduleCopy.disabled = false; } };
  document.getElementById('linkedinintel').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button'); button.disabled = true; button.textContent = 'Synthesizing…';
    try { await post('contacts/' + id + '/linkedin-research', formObject(e.target)); toast('Manual LinkedIn intel saved'); route(); }
    catch (err) { document.getElementById('linkedinmsg').textContent = err.message; button.disabled = false; button.textContent = 'Synthesize and save manual intel'; }
  };
  const queueButton = document.getElementById('queueprospect');
  if (queueButton) queueButton.onclick = async () => { await post('contacts/' + id + '/enrich', {}); toast('Queued for enrichment'); route(); };
  const detectTz = () => { const el = document.getElementById('detecttz') || document.getElementById('detecttz2'); if (!el) return; el.disabled = true; el.textContent = 'Detecting…'; post(`contacts/${id}/timezone`, { run_now: true }).then((res) => { toast(`Timezone ${res.timezone ? 'detected: ' + res.timezone : 'not detected'}`); route(); }).catch((err) => { toast(err.message); el.disabled = false; el.textContent = 'Detect timezone now'; }); };
  const detectTzBtn = document.getElementById('detecttz');
  if (detectTzBtn) detectTzBtn.onclick = detectTz;
  const detectTz2 = document.getElementById('detecttz2');
  if (detectTz2) detectTz2.onclick = detectTz;

  // pre-fill Jarvis's suggestion
  let activeTemplateId = null;
  if (planItem && planItem.draft) {
    const sub = document.getElementById('subject'), bod = document.getElementById('body');
    if (!sub.value) sub.value = planItem.draft.subject || '';
    if (!bod.value) bod.value = planItem.draft.body || '';
    activeTemplateId = planItem.draft.templateId;
    document.getElementById('email-draft-id').value = planItem.draft.emailDraftId || '';
    const sel = document.getElementById('tpl');
    if (sel && planItem.draft.templateId) sel.value = String(planItem.draft.templateId);
    const ch = document.querySelector('#compose select[name=channel]');
    if (ch && planItem.draft.channel) ch.value = planItem.draft.channel;
  }

  // template picker -> merge live against this person
  document.getElementById('tpl').onchange = (e) => {
    activeTemplateId = e.target.value ? +e.target.value : null;
    document.getElementById('email-draft-id').value = '';
    const t = d.templates.filter((x) => String(x.id) === e.target.value)[0];
    if (!t) return;
    document.getElementById('subject').value = merge(t.subject, c, co);
    document.getElementById('body').value = merge(t.body, c, co);
  };
  get('ai/status').then((status) => {
    const aiButton = document.getElementById('ai-draft');
    if (!aiButton) return;
    const remaining = Math.max(0, status.dailyLimit - status.usedToday);
    aiButton.textContent = status.available ? `Draft with AI (${remaining} left today)` : 'AI not enabled';
    aiButton.disabled = !status.available || remaining === 0;
  }).catch(() => {
    const aiButton = document.getElementById('ai-draft');
    if (aiButton) { aiButton.disabled = true; aiButton.textContent = 'AI unavailable'; }
  });
  document.getElementById('ai-draft').onclick = async () => {
    const button = document.getElementById('ai-draft');
    button.disabled = true;
    button.textContent = 'Drafting…';
    try {
      const result = await post('ai/draft', {
        contact_id: id,
        channel: document.querySelector('#compose select[name=channel]').value,
        goal: document.getElementById('ai-goal').value,
        tone: document.getElementById('ai-tone').value,
      });
      document.getElementById('subject').value = result.subject || '';
      document.getElementById('body').value = result.body || '';
      document.getElementById('tpl').value = '';
      activeTemplateId = null;
      document.getElementById('email-draft-id').value = '';
      document.getElementById('ai-notice').textContent = result.factsUsed && result.factsUsed.length
        ? 'Draft references: ' + result.factsUsed.join('; ') + '. Verify these details.'
        : 'No supporting facts were identified; verify every claim.';
      toast('AI draft ready — verify the facts before sending');
    } catch (error) {
      toast(error.message || 'AI unavailable');
    } finally {
      button.disabled = false;
      button.textContent = 'Draft with AI';
    }
  };

  document.getElementById('copy').onclick = () => {
    const txt = document.getElementById('subject').value + '\n\n' + document.getElementById('body').value;
    navigator.clipboard.writeText(txt).then(() => {
      document.getElementById('copied').textContent = 'copied — paste into your email client';
      setTimeout(() => { document.getElementById('copied').textContent = ''; }, 2500);
    });
  };
  document.getElementById('compose').onsubmit = async (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    if (!o.subject && !o.body) { toast('Write something first'); return; }
    o.template_id = activeTemplateId;
    await post('contacts/' + id + '/messages', o);
    toast('Logged — next follow-up scheduled');
    route();
  };
  document.getElementById('consentform').onsubmit = async (e) => {
    e.preventDefault();
    const data = formObject(e.target);
    if (data.action === 'withdrawn' && !confirm('Record withdrawal and permanently suppress this address from outreach?')) return;
    try { const result = await post('contacts/' + id + '/consent', data); toast(result.note || 'Consent event logged' + (result.suppressed ? ' · prior suppression remains' : '')); route(); }
    catch (error) { toast(error.message); }
  };
  document.getElementById('replyform').onsubmit = async (e) => {
    e.preventDefault();
    await post('contacts/' + id + '/replies', formObject(e.target));
    toast('Reply logged');
    route();
  };
  document.getElementById('statusform').onsubmit = async (e) => {
    e.preventDefault();
    await post('contacts/' + id + '/status', formObject(e.target));
    toast('Status updated');
    route();
  };
  document.getElementById('editct').onsubmit = async (e) => {
    e.preventDefault();
    await put('contacts/' + id, formObject(e.target));
    toast('Saved');
    route();
  };
  document.querySelectorAll('[data-snooze]').forEach((b) => {
    b.onclick = async () => {
      await post('contacts/' + id + '/snooze', { days: b.getAttribute('data-snooze') });
      toast('Snoozed');
      route();
    };
  });
  document.getElementById('delct').onclick = async () => {
    if (!confirm('Delete all data for this person? This permanently erases their contact details, research, messages, email drafts, replies, and project memberships. An anonymous audit event remains. A hashed opt-out entry is retained only if they had already unsubscribed.')) return;
    try { await del('contacts/' + id); toast('Prospect data erased'); location.hash = '#/companies/' + co.id; route(); }
    catch (error) { toast(error.message); }
  };
  const vb = document.getElementById('verifyemail');
  if (vb) vb.onclick = async () => {
    const out = document.getElementById('verifyresult');
    out.textContent = 'checking…';
    const r = await post('verify', { email: c.email });
    const colour = r.ok ? 'var(--good)' : r.status === 'unknown' ? 'var(--muted)' : 'var(--bad)';
    out.innerHTML = `<span style="color:${colour};font-weight:600">${esc(r.status.replace('_', ' '))}</span> — ${esc(r.reason)}`;
  };
}

/* -------------------------------------------------------------- schedule */
async function renderSchedule() {
  const d = await get('schedule');
  const tbl = (list, emptyMsg) => list.length ? `
    <div class="panel tight"><div class="scroll"><table>
    <thead><tr><th>When</th><th>Person</th><th>Company</th><th>Their local time</th><th>Niche</th><th>Email</th><th>Touches</th><th>Last touch</th><th></th></tr></thead><tbody>
    ${list.map((r) => `<tr>
      <td>${badge(r.bucket, r.next_action || 'now')}</td>
      <td><a href="#/contact/${r.id}"><b>${esc(r.name || '(unnamed)')}</b></a><br><span class="muted">${esc(r.title || '')}</span></td>
      <td><a href="#/companies/${r.company_id}">${esc(r.company_name)}</a><br><span class="muted">${esc(r.hq || '')}</span></td>
      <td>${localLine(r.local, r.timezone)}<br>${windowBadge(r.window)}</td>
      <td class="muted">${esc(r.sub_niche || '')}</td>
      <td class="mono">${esc(r.email || '—')}</td>
      <td class="mono">${r.touch_count}</td>
      <td class="mono">${esc(r.last_touch || '—')}</td>
      <td><div class="row" style="flex-wrap:nowrap">
        <a class="btn sm pri" href="#/contact/${r.id}">Send</a>
        <button class="btn sm" data-snooze="${r.id}" data-days="3">+3d</button>
        <button class="btn sm" data-snooze="${r.id}" data-days="7">+7d</button>
      </div></td></tr>`).join('')}
    </tbody></table></div></div>` : `<div class="panel empty">${emptyMsg}</div>`;

  appEl.innerHTML = `
  <h1>Squad schedule</h1>
  <p class="sub">Everyone who needs a follow-up, in order. Log a message and they roll forward by their cadence automatically.</p>
  <div class="stats">
    ${stat(d.groups.overdue.length,'Overdue','red')}${stat(d.groups.due.length,'Due today','amber')}
    ${stat(d.groups.week.length,'Next 7 days')}${stat(d.groups.later.length,'Scheduled later')}
  </div>
  <h2>Overdue <span class="muted" style="font-size:14px">— past their follow-up date</span></h2>
  ${tbl(d.groups.overdue, 'Nothing overdue.')}
  <h2>Due today</h2>${tbl(d.groups.due, 'Nothing due today.')}
  <h2>Next 7 days</h2>${tbl(d.groups.week, 'Nothing in the next week.')}
  <h2>Scheduled later</h2>${tbl(d.groups.later, 'Nothing further out.')}`;

  document.querySelectorAll('[data-snooze]').forEach((b) => {
    b.onclick = async () => {
      await post('contacts/' + b.getAttribute('data-snooze') + '/snooze', { days: b.getAttribute('data-days') });
      toast('Pushed back');
      route();
    };
  });
}

/* ------------------------------------------------------------- templates */
async function renderTemplates() {
  const d = await get('templates');
  appEl.innerHTML = `
  <h1>Message templates</h1>
  <p class="sub">Merge fields: <code>{{first_name}}</code> <code>{{company}}</code> <code>{{sub_niche}}</code>
    <code>{{what_they_do}}</code> <code>{{hq}}</code> <code>{{founded}}</code> <code>{{funding}}</code>
    <code>{{title}}</code> <code>{{full_name}}</code></p>
  <div class="panel"><h3>Add a template</h3><form id="addtpl">
    <div class="f">
      <div><label>Name</label><input name="name" required placeholder="Touch 1 — cold intro"></div>
      <div><label>Channel</label><select name="channel">${CHANNELS.map((x) => `<option value="${x}">${x}</option>`).join('')}</select></div>
    </div>
    <div class="f one"><div><label>Subject</label><input name="subject" placeholder="{{first_name}} — quick one on {{company}}"></div></div>
    <div class="f one"><div><label>Body</label><textarea name="body" style="min-height:150px"></textarea></div></div>
    <button class="btn pri">Save template</button>
  </form></div>
  ${d.templates.map((t) => `
    <div class="panel"><form class="edittpl" data-id="${t.id}">
      <div class="f">
        <div><label>Name</label><input name="name" value="${esc(t.name)}"></div>
        <div><label>Channel</label><select name="channel">${CHANNELS.map((x) => `<option value="${x}"${x === t.channel ? ' selected' : ''}>${x}</option>`).join('')}</select></div>
      </div>
      <div class="f one"><div><label>Subject</label><input name="subject" value="${esc(t.subject || '')}"></div></div>
      <div class="f one"><div><label>Body</label><textarea name="body" style="min-height:150px">${esc(t.body || '')}</textarea></div></div>
      <div class="row"><button class="btn pri">Save</button>
        <button type="button" class="btn gh sm deltpl" data-id="${t.id}">Delete</button></div>
    </form></div>`).join('')}`;

  document.getElementById('addtpl').onsubmit = async (e) => {
    e.preventDefault();
    await post('templates', formObject(e.target));
    toast('Template added'); route();
  };
  document.querySelectorAll('.edittpl').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      await put('templates/' + f.getAttribute('data-id'), formObject(e.target));
      toast('Saved'); route();
    };
  });
  document.querySelectorAll('.deltpl').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete template?')) return;
      await del('templates/' + b.getAttribute('data-id'));
      route();
    };
  });
}

/* -------------------------------------------------------------- settings */
async function renderSettings() {
  const [s, aiStatus, enrichUsage, gmailStatus, sequenceData] = await Promise.all([get('settings'), get('ai/status').catch(() => ({ available: false, providers: [] })), get('enrichment/usage').catch(() => ({ usage: {}, caps: {}, queue: [] })), get('gmail/status').catch(() => ({ status: 'disconnected', configured: false, queue: [] })), get('sequences').catch(() => ({ sequences: [] }))]);
  const cadenceSequences = sequenceData.sequences || [];
  let savedDns = null; try { savedDns = s.deliverability_dns_result ? JSON.parse(s.deliverability_dns_result) : null; } catch {}
  const domainForDns = s.sending_domain || '';
  const freeGmail = /@(gmail|googlemail)\.com$/i.test(String(gmailStatus.email_address || ''));
  const wizardComplete = String(s.deliverability_wizard_complete || '0') === '1';
  const dnsAllPass = !!savedDns?.checks && savedDns.domain === domainForDns && String(savedDns.selector || 'google') === String(s.dkim_selector || 'google') && ['spf','dkim','dmarc'].every((key) => !!savedDns.checks[key]?.pass);
  const renderDnsSummary = (result) => {
    const checks = result?.checks || {};
    return ['spf','dkim','dmarc'].map((key) => { const item=checks[key]||{}; const title=key.toUpperCase(); return `<div>${item.pass?'✓':'✗'} <b>${title}</b>: ${item.pass?'PASS':'FAIL'}${item.error?' · '+esc(item.error):''}${item.note?' · '+esc(item.note):''}</div>`; }).join('') + (result?.checked_at ? `<div class="muted">Checked ${esc(result.checked_at)}</div>` : '');
  };
  appEl.innerHTML = `
  <h1>Backup &amp; settings</h1>
  <p class="sub">Your data lives in a Cloudflare D1 database — it is stored on Cloudflare, not in this browser,
    so laptop and phone see the same queue.</p>

  <div class="panel" id="deliverability-wizard" style="border-color:${wizardComplete ? 'var(--ok)' : 'var(--warn,#C58A00)'}">
    <div class="row"><h3 style="margin:0">First-run deliverability setup</h3><span class="sp"></span><span class="b ${wizardComplete ? 'replied' : 'due'}">${wizardComplete ? 'Setup recorded' : 'Setup needed'}</span></div>
    <p class="muted">Configure DNS for a domain you control and verify SPF, DKIM, and DMARC. The worker sends from the connected Gmail account’s primary address, so check the domain used by that mailbox; this build does not send from an unverified alias. A free <code>@gmail.com</code> mailbox cannot be authenticated with your own DNS—use Google Workspace on a separate outreach domain. These checks are guidance and DNS can take time to propagate; actual Gmail delivery remains subject to provider policies.</p>
    <form id="dnsform"><div class="f">
      <div><label>Sending domain you control</label><input name="sending_domain" value="${esc(domainForDns)}" placeholder="outreach.example.com" required></div>
      <div><label>DKIM selector from Google Workspace Admin</label><input name="dkim_selector" value="${esc(s.dkim_selector || 'google')}" placeholder="google" required></div>
    </div><div class="row"><button type="submit" class="btn">Save domain details</button><button type="button" class="btn pri" id="dnscheck">Check SPF, DKIM &amp; DMARC</button><span id="dns-message" class="small muted"></span></div></form>
    <div class="card pad-sm mt" style="box-shadow:none"><b>Records to configure (Google Workspace sender)</b>
      <ul class="small"><li><b>SPF</b> · host <code>@</code> · TXT <code>v=spf1 include:_spf.google.com ~all</code>. Merge Google into your existing SPF policy; never publish multiple SPF records.</li>
        <li><b>DKIM</b> · host <code>${esc(s.dkim_selector || 'google')}._domainkey</code> · TXT value generated in Google Admin → Gmail → Authenticate email. Publish the actual key shown there; this app cannot generate or guess it.</li>
        <li><b>DMARC</b> · host <code>_dmarc</code> · TXT <code>v=DMARC1; p=none; rua=mailto:dmarc@${esc(domainForDns || 'your-domain')}</code>. Use a mailbox you monitor; tighten policy only after reviewing reports.</li></ul>
    </div>
    <div id="dns-results" class="small mt">${savedDns ? renderDnsSummary(savedDns) : 'No DNS check has been run yet.'}</div>
    <div class="row mt"><button class="btn" id="finish-wizard" ${wizardComplete || !dnsAllPass || !String(s.physical_mailing_address || '').trim() ? 'disabled' : ''}>${wizardComplete ? 'Setup complete' : 'Finish after all three checks pass'}</button><span class="small muted">Requires a saved physical mailing address and passing SPF/DKIM/DMARC.</span></div>
    ${freeGmail && Number(s.daily_send_cap || 25) > 10 ? `<p class="small" style="color:var(--bad)"><b>Free Gmail volume warning:</b> configured cap is above 10/day. Free Gmail is not appropriate for high-volume cold outreach. Use a separate, authenticated outreach domain and mailbox, never your main company domain, or lower the cap to 10/day or less.</p>` : ''}
  </div>

  <div class="panel"><h3>Backup</h3>
    <p class="muted">Download everything as one JSON file. Keep it somewhere safe — it is your insurance policy
      and it is also how you move data between machines.</p>
    <div class="row">
      <button class="btn pri" id="dl">Download backup (JSON)</button>
      <button class="btn" id="csv">Export CSV</button>
      <label class="btn" style="margin:0">Restore from backup…
        <input type="file" id="file" accept=".json" style="display:none"></label>
    </div>
    <p class="muted" style="margin-top:10px">Restoring <b>replaces</b> everything currently in the database with the file's contents.</p>
  </div>

  <div class="panel"><h3>Follow-up cadence</h3>
    <form id="cadform"><div class="f one"><div><label>Default cadence (days)</label>
      <input type="number" name="default_cadence" value="${esc(s.default_cadence || '4')}" min="1" max="30"></div></div>
      <button class="btn pri">Save</button></form>
    <p class="muted" style="margin-top:8px">The brief calls for 3–5 days; 4 is the default and each person can be overridden.</p>
  </div>

  <div class="panel"><h3>Gmail sequence cadence</h3>
    <p class="muted" style="margin-top:0">Delays count business days, Monday through Friday. Sends still wait for the prospect-local Monday–Thursday, 9–11 a.m. window. Step 1 is day 0; steps 2–4 default to 3, 4 and 5 business days. Gmail drafts supply the message content; a selected sequence supplies the per-step cadence.</p>
    <form id="gmailcadenceform"><div class="f">
      ${[['Step 2 after','gmail_step2_business_days','3'],['Step 3 after','gmail_step3_business_days','4'],['Step 4 after','gmail_step4_business_days','5']].map(([label,key,fallback])=>`<div><label>${label} (business days)</label><input type="number" name="${key}" min="0" max="60" value="${esc(s[key] ?? fallback)}"></div>`).join('')}
    </div><button class="btn pri">Save default Gmail cadence</button></form>
    <h4>Per-sequence cadence</h4>
    ${cadenceSequences.length ? cadenceSequences.map((sq)=>`<form class="seq-cadence-form card pad-sm mb" data-sequence-id="${sq.id}" style="box-shadow:none"><div class="row"><b>${esc(sq.name)}</b><span class="sp"></span><span class="small muted">${sq.steps.length} steps</span></div><div class="f">
      ${[2,3,4].map((order)=>{const step=sq.steps.find(x=>Number(x.step_order)===order);return `<div><label>Step ${order} after (business days)</label><input type="number" min="0" max="60" name="wait_${order}" value="${step?esc(step.wait_days):''}" ${step?'':'disabled'} data-step-id="${step?.id||''}" placeholder="No step"></div>`}).join('')}
    </div><button class="btn sm pri" ${[2,3,4].some(order=>!sq.steps.some(x=>Number(x.step_order)===order))?'disabled':''}>Save ${esc(sq.name)} cadence</button></form>`).join('') : '<p class="small muted">Create a sequence in Sequence Builder to set a cadence for it here.</p>'}
    <p class="small muted">A prospect can be enrolled in a selected sequence when you schedule their reviewed Gmail drafts. Without a selection, the default cadence above applies.</p>
  </div>

  <div class="panel"><h3>Deliverability guardrails</h3>
    <p class="muted" style="margin-top:0">Code-enforced warmup: week 1 at most 5 sends/day, week 2 at most 10, week 3 at most 15, and week 4 onward at most your configured daily cap (default 25). If the start date is blank, the system starts at week 1 on the first send. Enter the original date only if this sending domain has already been warmed gradually.</p>
    <p class="small"><b>Effective today:</b> ${gmailStatus.daily_cap ?? 5}/day · warmup week ${gmailStatus.warmup_week || 1} · start ${esc(gmailStatus.warmup_start_date || 'first send')}</p>
    <form id="capform">
      <div class="f">
        <div><label>Existing global daily cap</label><input type="number" name="daily_cap" min="5" max="200" value="${esc(s.daily_cap || '30')}"></div>
        <div><label>Automated Gmail sends per day</label><input type="number" name="daily_send_cap" min="0" max="500" value="${esc(s.daily_send_cap ?? '25')}"></div>
        <div><label>Warmup start date (leave blank for first send)</label><input type="date" name="domain_start" value="${esc(s.domain_start || '')}"></div>
      </div>
      <div class="row"><button class="btn pri">Save</button>
        <span class="muted small" id="capmsg">A blank date initializes week 1 at the first send; enter an earlier date only for a domain already ramped up.</span></div>
    </form>
    <div id="capnow" class="mt"></div>
  </div>

  <div class="panel" style="border-color:${gmailStatus.master_paused ? 'var(--bad)' : 'var(--ok)'}"><div class="row"><h3 style="margin:0">Master sending pause</h3><span class="sp"></span><span class="b ${gmailStatus.master_paused ? 'passed' : 'replied'}">${gmailStatus.master_paused ? 'PAUSED' : 'Sending enabled'}</span></div>
    <p class="small muted">This control blocks every automated Gmail send path immediately and pauses queued messages. Reply sync may continue. Use it before maintenance or whenever outreach must stop.</p>
    <button class="btn ${gmailStatus.master_paused ? 'pri' : ''}" id="master-pause">${gmailStatus.master_paused ? 'Resume automated sending' : 'Pause all sending'}</button>
  </div>

  <div class="panel"><h3>Gmail sending</h3>
    <p class="muted">${gmailStatus.status === 'connected' ? `Connected to <b>${esc(gmailStatus.email_address)}</b>. Scheduled messages send automatically only after you schedule a reviewed sequence.` : gmailStatus.status === 'reconnect_required' ? 'Gmail authorization failed. All automated sequences are paused until you reconnect.' : 'Connect the Origami sending mailbox. OAuth tokens are encrypted in D1 with a separate server secret.'}</p>
    ${gmailStatus.last_error ? `<p class="small" style="color:var(--bad)">${esc(gmailStatus.last_error)}</p>` : ''}
    <div class="row"><button class="btn pri" id="gmail-connect" ${gmailStatus.configured ? '' : 'disabled'}>${gmailStatus.status === 'reconnect_required' ? 'Reconnect Gmail' : gmailStatus.status === 'connected' ? 'Reconnect Gmail' : 'Connect Gmail'}</button>
    ${gmailStatus.status === 'connected' ? '<button class="btn" id="gmail-disconnect">Disconnect</button>' : ''}
    ${(gmailStatus.queue || []).some((x) => ['paused_auth','paused_timezone','paused_config'].includes(x.status)) ? '<button class="btn" id="gmail-resume">Resume paused sends</button>' : ''}
    <span class="small muted">${gmailStatus.configured ? `${gmailStatus.attempts_today} send attempts today` : 'Set Google OAuth client ID, client secret, and token encryption key as server secrets.'}</span></div>
    <p class="small muted">Safety: at most one send per 10-minute worker run, no more than the configured daily cap or 500 per UTC day, and only 9:00–11:00 local time Monday–Thursday. No randomized timing to disguise automation. Human replies stop remaining emails; dated out-of-office replies pause and reschedule after the return date.</p>
    <p class="small muted">Google’s <code>gmail.readonly</code> scope is restricted. Public production use may require Google verification and a security assessment. OAuth apps left in Testing can issue refresh tokens that expire after seven days.</p>
    <h4>Recent send history</h4><div id="gmail-send-log" class="small muted">Loading…</div>
  </div>

  <div class="panel"><h3>Sender profile &amp; planning window</h3>
    <p class="muted" style="margin-top:0">A valid physical mailing address is required before automatic Gmail delivery. The manual planning window below does not change the automated Gmail window, which is fixed at 9–11 a.m. prospect-local time Monday through Thursday. Messages send only after you explicitly schedule reviewed drafts.</p>
    <form id="senderform">
      <div class="f">
        <div><label>Sender name</label><input name="sender_name" value="${esc(s.sender_name || '')}" placeholder="Your name" required></div>
        <div><label>Sender company</label><input name="sender_company" value="${esc(s.sender_company || 'Origami Consulting')}" required></div>
      </div>
      <div class="f one"><div><label>Physical mailing address (required before sending)</label><textarea name="physical_mailing_address" rows="3" placeholder="Street address, city, region, postal code, country" required>${esc(s.physical_mailing_address || '')}</textarea></div></div>
      <div class="f">
        <div><label>Sending window starts (local hour)</label><select name="sending_window_start_hour">${Array.from({length:24},(_,h)=>`<option value="${h}"${Number(s.sending_window_start_hour ?? 9)===h?' selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}</select></div>
        <div><label>Sending window ends (local hour)</label><select name="sending_window_end_hour">${Array.from({length:24},(_,h)=>`<option value="${h}"${Number(s.sending_window_end_hour ?? 17)===h?' selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}</select></div>
      </div>
      <button class="btn pri">Save sender profile</button>
    </form>
  </div>

  <div class="panel"><h3>B2B prospect data &amp; lawful-basis note</h3>
    <p class="muted" style="margin-top:0"><b>Prospect data is stored only for B2B outreach purposes.</b> The data categories are name, company, email, research notes, and correspondence. Limit stored prospect data to relevant B2B outreach and follow-up administration. Do not collect sensitive personal data or reuse these records for unrelated purposes. Keep information accurate, minimize retention, and honor access, objection, and erasure requests. A legitimate-interest note is not legal advice; assess suitability for your actual jurisdictions and document your balancing test.</p>
    <form id="privacyform"><div class="f one"><div><label>Prospect data use &amp; legitimate-interest note</label><textarea name="legitimate_interest_note" rows="4" maxlength="2000">${esc(s.legitimate_interest_note || 'Prospect data is stored only for B2B outreach purposes. Data categories: name, company, email, research notes, and correspondence. Use data only for relevant business outreach and follow-up administration. Minimize data, honor objections immediately, and erase data on request. Do not store sensitive personal data.')}</textarea></div></div><button class="btn pri">Save privacy note</button></form>
    <p class="small muted">On erasure, contact-linked records are removed. If the person had opted out, a SHA-256 email digest is retained solely to keep honoring that permanent suppression. It is pseudonymous suppression data, not plaintext, and must still be protected.</p>
  </div>

  <div class="panel"><h3>Phase 1 enrichment &amp; ICP</h3>
    <p class="muted" style="margin-top:0">CSV imports and manually added prospects enter the queue. The scheduler processes at most 10 per hour. Add provider keys as Cloudflare secrets or private local environment variables; this page never accepts or displays secrets. LinkedIn profile URLs are stored as data only, never fetched.</p>
    <form id="icpform">
      <div class="f one"><div><label>Decision-making authority</label><textarea name="icp_authority" rows="2">${esc(s.icp_authority || '')}</textarea></div></div>
      <div class="f"><div><label>Minimum company size</label><input type="number" name="icp_company_size_min" min="0" value="${esc(s.icp_company_size_min || '10')}"></div>
        <div><label>Maximum company size</label><input type="number" name="icp_company_size_max" min="0" value="${esc(s.icp_company_size_max || '500')}"></div></div>
      <div class="f one"><div><label>Technology / services fit for Origami</label><textarea name="icp_technology_fit" rows="3">${esc(s.icp_technology_fit || '')}</textarea></div></div>
      <div class="row"><button class="btn pri">Save ICP settings</button></div>
    </form>
    <h4>Provider quota guardrails (tracked in D1)</h4>
    <p class="small muted">Set these at or below your actual free-plan limits. These are safety caps, not provider guarantees; successful requests only are counted and 429 responses block the current period.</p>
    <form id="quotaform"><div class="grid3">
      ${[['apollo_daily_cap','Apollo daily'],['apollo_monthly_cap','Apollo monthly'],['hunter_daily_cap','Hunter daily'],['hunter_monthly_cap','Hunter monthly'],['firecrawl_daily_cap','Firecrawl daily pages'],['firecrawl_monthly_cap','Firecrawl monthly pages'],['tavily_daily_cap','Tavily daily searches'],['tavily_monthly_cap','Tavily monthly searches'],['serper_daily_cap','Serper daily'],['serper_lifetime_cap','Serper account total'],['groq_daily_cap','Groq daily'],['gemini_daily_cap','Gemini daily'],['openrouter_daily_cap','OpenRouter daily'],['copywriting_hourly_cap','Copywriting drafts per hour']].map(([key,label])=>`<div><label>${label}</label><input type="number" min="0" max="${key === 'copywriting_hourly_cap' ? 100 : 1000000}" name="${key}" value="${esc(s[key] ?? '')}"></div>`).join('')}
    </div><div class="row mt"><button class="btn pri">Save quota limits</button></div></form>
    <div class="small muted mt" id="provider-usage">Loading quota usage…</div>
    <div class="row mt"><button type="button" class="btn" id="runenrichment">Run enrichment and queued copywriting (max 10 each/hour)</button><span class="small muted" id="enrich-run-result"></span></div>
  </div>

  <div class="panel"><h3>API key status &amp; connection tests</h3>
    <p class="muted" style="margin-top:0">Keys remain server-side and are never displayed or accepted in this form. Each test uses one provider health/usage request; no automatic retry occurs. Serper's test performs one search and consumes one query.</p>
    <div class="grid3">${[['apollo','Apollo'],['hunter','Hunter'],['firecrawl','Firecrawl'],['tavily','Tavily'],['serper','Serper'],['groq','Groq'],['gemini','Gemini'],['openrouter','OpenRouter']].map(([name,label])=>{const configured=!!enrichUsage.configured?.[name];const model=(aiStatus.providers||[]).find((x)=>x.name===name)?.model;return `<div class="card pad-sm"><div class="row"><b>${label}</b><span class="sp"></span><span class="b ${configured?'replied':'plain'}">${configured?'Configured':'Missing'}</span></div>${model?`<div class="sub2">${esc(model)}</div>`:''}<div class="row mt"><button type="button" class="btn xs" data-provider-test="${name}" ${configured?'':'disabled'}>${name==='serper'?'Test (1 query)':'Test key'}</button><span class="sub2" id="provider-test-${name}"></span></div></div>`}).join('')}</div>
    <div class="small muted mt">The server uses Groq first, Gemini second, then OpenRouter for LLM requests. Apollo/Hunter tests use account/auth endpoints and do not run a prospect enrichment lookup. Gmail sends require explicit scheduling of reviewed drafts. No secrets are exposed in API responses.</div>
  </div>

  <div class="panel"><h3>Your timezone</h3>
    <p class="muted" style="margin-top:0">Jarvis shows every prospect's clock in their city, and yours here,
      so you can see at a glance whose working day overlaps with yours.</p>
    <form id="tzuser">
      <div class="f one"><div><label>Your timezone (IANA)</label>
        <input name="user_tz" value="${esc(s.user_tz || USER_TZ || '')}" placeholder="Asia/Kolkata"></div></div>
      <div class="row">
        <button class="btn pri">Save</button>
        <button type="button" class="btn" id="autotz">Detect from this device</button>
        <span class="muted" id="tzumsg"></span>
      </div>
    </form>
  </div>

  <div class="panel"><h3>Detect timezones</h3>
    <p class="muted" style="margin-top:0">Reads each company's HQ and fills in city, country and
      timezone, so follow-ups can skip their weekends and public holidays. Run it once after
      restoring a backup, and again whenever you add companies in bulk.</p>
    <div class="row">
      <button class="btn pri" id="detectall">Detect timezones for all companies</button>
      <span class="muted" id="detectmsg"></span>
    </div>
  </div>

  <div class="panel"><h3>Snippets</h3>
    <p class="muted" style="margin-top:0">Reusable fragments you paste while composing — the sentence you write
      fifty times a week should live in one place.</p>
    <form id="snipform" class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div style="min-width:150px"><label>Name</label><input name="name" placeholder="Origami intro" required></div>
      <div style="min-width:110px"><label>Shortcut</label><input name="shortcut" placeholder="/intro"></div>
      <div style="flex:1;min-width:220px"><label>Text</label><input name="body" placeholder="We build custom marketplace platforms…" required></div>
      <button class="btn pri">Add</button>
    </form>
    <div id="snip-list" class="mt"></div>
  </div>

  <div class="panel"><h3>Smart spreadsheet import</h3>
    <p class="muted" style="margin-top:0">Upload Excel or CSV data with missing fields. The importer recognizes common header variations,
      derives domains from websites or emails, combines funding fields, supports multiple decision makers per company,
      skips duplicate people, and detects HQ timezones automatically.</p>
    <div class="row">
      <label class="btn pri" style="margin:0">Choose Excel / CSV file…
        <input type="file" id="csvfile" accept=".xlsx,.csv,.tsv,.txt" style="display:none"></label>
      <span class="muted" id="csvmsg"></span>
    </div>
    <div id="csvmap"></div>
  </div>

  <div class="panel"><h3>Account</h3>
    <p class="muted">${AUTH_CONFIGURED
      ? 'Secure sign-in is enabled. Sessions expire automatically; sign out on shared devices.'
      : 'Locked: the server authentication secret is missing. The data API fails closed until it is configured.'}</p>
    <div class="row">${AUTH_REQUIRED ? '<button class="btn" id="logout">Lock / sign out</button>' : ''}
      <a class="btn" href="#/">Back to dashboard</a></div>
  </div>`;

  const gmailConnect = document.getElementById('gmail-connect');
  if (gmailConnect) gmailConnect.onclick = () => { window.location.href = '/api/gmail/oauth/start'; };
  const gmailDisconnect = document.getElementById('gmail-disconnect');
  if (gmailDisconnect) gmailDisconnect.onclick = async () => { if (!confirm('Disconnect Gmail and pause all scheduled sends?')) return; await post('gmail/disconnect', {}); toast('Gmail disconnected and sends paused'); route(); };
  const gmailResume = document.getElementById('gmail-resume');
  if (gmailResume) gmailResume.onclick = async () => { try { const r = await post('gmail/resume', {}); toast(`${r.resumed ? 'Paused sends resumed' : 'No sends resumed'}`); route(); } catch (err) { toast(err.message); } };
  get('gmail/log').then((log) => {
    const box = document.getElementById('gmail-send-log'); if (!box) return;
    box.innerHTML = (log.emails || []).length ? `<div class="scroll"><table><thead><tr><th>Scheduled</th><th>Contact</th><th>Step</th><th>Status</th><th>Attempts</th><th>Details</th></tr></thead><tbody>${log.emails.map((e) => `<tr><td>${esc(e.scheduled_at || '')}</td><td>${esc(e.contact_name)} · ${esc(e.recipient_email || '')}</td><td>${e.step_number}</td><td>${esc(e.status)}</td><td>${e.attempts}</td><td>${esc(e.last_error || e.gmail_message_id || '')}</td></tr>`).join('')}</tbody></table></div><details class="mt"><summary>Attempt audit (${(log.attempts || []).length})</summary><div class="scroll"><table><thead><tr><th>Time</th><th>Contact</th><th>Step</th><th>Status</th><th>HTTP</th><th>Error</th></tr></thead><tbody>${(log.attempts || []).map((a) => `<tr><td>${esc(a.attempted_at)}</td><td>${esc(a.contact_name)}</td><td>${a.step_number}</td><td>${esc(a.status)}</td><td>${esc(a.http_status || '')}</td><td>${esc(a.error || '')}</td></tr>`).join('')}</tbody></table></div></details>` : 'No scheduled or attempted Gmail emails yet.';
  }).catch(() => { const box = document.getElementById('gmail-send-log'); if (box) box.textContent = 'Send history is unavailable.'; });
  document.getElementById('dl').onclick = async () => {
    const data = await get('backup');
    download('crm-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
  };
  document.getElementById('csv').onclick = async () => {
    const res = await fetch('/api/export');
    download('outreach_export.csv', await res.blob(), 'text/csv');
  };
  document.getElementById('file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!confirm('Restore from ' + f.name + '? This replaces everything in the database.')) return;
    const parsed = JSON.parse(await f.text());
    const r = await post('import', Object.assign({ wipe: true }, parsed));
    toast('Restored ' + (r.companies || 0) + ' companies');
    location.hash = '#/companies'; route();
  };
  document.getElementById('icpform').onsubmit = async (e) => {
    e.preventDefault(); await post('settings', formObject(e.target)); toast('ICP settings saved');
  };
  document.getElementById('quotaform').onsubmit = async (e) => {
    e.preventDefault(); await post('settings', formObject(e.target)); toast('Provider quota limits saved'); route();
  };
  document.getElementById('gmailcadenceform').onsubmit = async (e) => {
    e.preventDefault(); await post('settings', formObject(e.target)); toast('Default Gmail business-day cadence saved'); route();
  };
  document.getElementById('dnsform').onsubmit = async (e) => {
    e.preventDefault();
    try { await post('settings', formObject(e.target)); toast('Sending domain saved'); route(); }
    catch (error) { toast(error.message); }
  };
  document.getElementById('dnscheck').onclick = async () => {
    const msg = document.getElementById('dns-message'); const button = document.getElementById('dnscheck');
    const fields = formObject(document.getElementById('dnsform'));
    button.disabled = true; msg.textContent = 'Checking public DNS…';
    try { const result = await post('deliverability/dns-check', { domain: fields.sending_domain, dkim_selector: fields.dkim_selector }); msg.textContent = result.all_pass ? 'All three checks pass.' : 'One or more checks still fail; add/fix the records and check again.'; toast(result.all_pass ? 'SPF, DKIM, and DMARC pass' : 'DNS check finished'); route(); }
    catch (error) { msg.textContent = error.message; button.disabled = false; }
  };
  document.getElementById('finish-wizard').onclick = async () => {
    try { await post('settings', { deliverability_wizard_complete: '1' }); toast('Deliverability setup recorded'); route(); }
    catch (error) { toast(error.message); }
  };
  document.getElementById('master-pause').onclick = async () => {
    const pause = !gmailStatus.master_paused;
    if (pause && !confirm('Pause all automated Gmail sending now?')) return;
    try { await post('settings', { master_send_paused: pause ? '1' : '0' }); toast(pause ? 'All automated sends paused' : 'Automated sending resumed'); route(); }
    catch (error) { toast(error.message); }
  };
  document.getElementById('privacyform').onsubmit = async (e) => {
    e.preventDefault();
    try { await post('settings', formObject(e.target)); toast('Privacy note saved'); }
    catch (error) { toast(error.message); }
  };
  document.querySelectorAll('.seq-cadence-form').forEach((form) => form.onsubmit = async (e) => {
    e.preventDefault(); const steps = [2,3,4].map((order)=>({order, input:form.querySelector(`[name=wait_${order}]`)})).filter(x=>x.input);
    try { for (const item of steps) await put('steps/' + item.input.dataset.stepId, { wait_days:Number(item.input.value) }); toast('Sequence business-day cadence saved'); route(); }
    catch (err) { toast(err.message); }
  });
  const quotaLines = Object.entries(enrichUsage.usage || {}).map(([provider, rows]) => `${provider}: ${rows.map((r) => `${r.window_type} ${r.used}`).join(' · ')}`).join(' | ');
  document.getElementById('provider-usage').textContent = `Providers: ${Object.entries(enrichUsage.configured || {}).map(([name,yes]) => `${name} ${yes ? 'configured' : 'missing'}`).join(' · ') || 'not checked'} · Usage: ${quotaLines || 'No calls recorded yet.'} · Queue: ${(enrichUsage.queue || []).map((x) => `${x.queue || 'enrichment'} ${x.status} ${x.count}`).join(' · ') || 'empty'}`;
  qsa('[data-provider-test]').forEach((button) => button.onclick = async () => {
    const name=button.dataset.providerTest, output=document.getElementById('provider-test-'+name);
    button.disabled=true; if(output) output.textContent='Testing…';
    try { const result=await post('providers/test',{provider:name}); if(output) output.textContent=(result.ok?'Connected: ':'Failed: ')+result.message+(result.quota_consumed?' (one query used)':''); }
    catch(err) { if(output) output.textContent=err.message; }
    finally { button.disabled=false; }
  });
  document.getElementById('runenrichment').onclick = async () => {
    const out = document.getElementById('enrich-run-result'); out.textContent = 'Processing…';
    try { const r = await post('enrichment/run', {}); out.textContent = `${r.enrichment?.processed || 0} enrichment · ${r.copywriting?.processed || 0} copywriting`; toast('Enrichment and copywriting batch finished'); }
    catch (err) { out.textContent = err.message; }
  };

  document.getElementById('senderform').onsubmit = async (e) => {
    e.preventDefault();
    try { await post('settings', formObject(e.target)); toast('Sender profile and window saved'); route(); }
    catch (error) { toast(error.message); }
  };
  document.getElementById('cadform').onsubmit = async (e) => {
    e.preventDefault();
    await post('settings', formObject(e.target));
    toast('Saved');
  };
  document.getElementById('capform').onsubmit = async (e) => {
    e.preventDefault();
    await post('settings', formObject(e.target));
    toast('Guardrails saved'); drawGuard();
  };
  async function drawGuard() {
    const g = await get('guardrails').catch(() => null);
    const box = document.getElementById('capnow');
    if (!g || !box) return;
    box.innerHTML = `<div class="card pad-sm" style="box-shadow:none">
      <div class="row" style="justify-content:space-between">
        <span><b>${g.sentToday}</b> of ${g.effective} sent today · ${g.remaining} left</span>
        <span class="b ${g.level === 'over' ? 'passed' : g.level === 'near' ? 'due' : 'replied'}">${g.level}</span>
      </div>
      <div class="bar mt" style="height:8px"><i class="${g.level === 'over' ? '' : g.level === 'near' ? 'warn' : 'ok'}" style="width:${g.pct}%"></i></div>
    </div>`;
  }
  drawGuard();
  document.getElementById('detectall').onclick = async () => {
    const msg = document.getElementById('detectmsg');
    msg.textContent = 'working…';
    try {
      const r = await post('detect-all', {}, { 'x-force': '1' });
      msg.textContent = `done — ${r.updated} updated` + (r.unresolved ? `, ${r.unresolved} could not be resolved` : '');
      toast('Timezones detected: ' + r.updated);
    } catch (e) {
      msg.textContent = 'failed: ' + e.message;
    }
  };
  document.getElementById('tzuser').onsubmit = async (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    USER_TZ = o.user_tz;
    await post('settings', o);
    toast('Timezone saved');
    route();
  };
  document.getElementById('autotz').onclick = () => {
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    document.querySelector('#tzuser input[name=user_tz]').value = mine;
    document.getElementById('tzumsg').textContent = mine ? 'detected ' + mine + ' — press Save' : 'not available';
  };
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { try { await post('logout', {}); } finally { localStorage.removeItem('ocrm_token'); renderLogin('Signed out.'); } };

  /* ---- snippets ---- */
  const snipList = document.getElementById('snip-list');
  async function drawSnippets() {
    const d = await get('snippets');
    snipList.innerHTML = d.snippets.length ? d.snippets.map((s) => `
      <div class="row" style="gap:8px;padding:7px 0;border-bottom:1px solid #F0F1F4;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <b>${esc(s.name)}</b> ${s.shortcut ? `<span class="b plain mono">${esc(s.shortcut)}</span>` : ''}
          <div class="sub2">${esc((s.body || '').slice(0, 120))}${(s.body || '').length > 120 ? '…' : ''}</div>
        </div>
        <button class="iconbtn" data-snipcopy="${s.id}" title="Copy">⧉</button>
        <button class="iconbtn" data-snipdel="${s.id}" title="Delete">✕</button>
      </div>`).join('') : '<div class="small faint">No snippets yet.</div>';
    snipList.querySelectorAll('[data-snipcopy]').forEach((b) => b.onclick = async () => {
      const sn = d.snippets.find((x) => x.id === +b.dataset.snipcopy);
      navigator.clipboard.writeText(sn.body); toast('Copied “' + sn.name + '”');
    });
    snipList.querySelectorAll('[data-snipdel]').forEach((b) => b.onclick = async () => {
      await del('snippets/' + b.dataset.snipdel); drawSnippets();
    });
  }
  document.getElementById('snipform').onsubmit = async (e) => {
    e.preventDefault();
    await post('snippets', formObject(e.target));
    e.target.reset();
    drawSnippets(); toast('Snippet saved');
  };
  drawSnippets();

  /* ---- smart Excel / CSV import with column mapping ---- */
  const FIELDS = [
    ['company', 'Company name'], ['domain', 'Domain'], ['website', 'Company website'],
    ['linkedin', 'Company LinkedIn'], ['sub_niche', 'Sub-niche'], ['what_they_do', 'What they do'],
    ['hq', 'HQ location'], ['city', 'City'], ['country', 'Country'], ['founded', 'Founded'], ['employees', 'Employees'], ['funding', 'Funding (combined)'],
    ['funding_stage', 'Funding stage'], ['total_raised', 'Total raised'], ['last_funding_date', 'Last funding date'],
    ['open_eng_roles', 'Open engineering roles'], ['recent_news', 'Recent news / recent activity'], ['live_product', 'Live product (Y/N)'], ['founders', 'Founders'], ['technical_lead', 'CTO / technical co-founder (Y/N)'], ['source', 'Company source URLs'],
    ['public_appearances', 'Public appearances'], ['criteria_flags', 'Flags / criteria check'],
    ['contact', 'Decision maker'], ['first_name', 'First name'], ['last_name', 'Last name'], ['title', 'Title'],
    ['dm_linkedin', 'DM LinkedIn'], ['email', 'Email'], ['phone', 'Phone'], ['time_in_role', 'DM time in role'],
    ['previous_roles', 'DM previous roles'], ['education', 'DM education'], ['notes', 'Notes / extra context'],
  ];
  const HEADER_ALIASES = {
    company: ['company', 'company name', 'organization', 'organisation', 'startup', 'business', 'account name'],
    domain: ['domain', 'company domain', 'domain name'],
    website: ['website', 'company website', 'company site', 'site', 'company url', 'url'],
    linkedin: ['company linkedin', 'company linkedin url', 'linkedin company', 'company linkedin page', 'linkedin'],
    sub_niche: ['sub niche', 'subniche', 'niche', 'industry', 'vertical'],
    what_they_do: ['what they do', 'what the product does', 'company description', 'description', 'about', 'product', 'business description'],
    hq: ['hq', 'hq location', 'headquarters', 'headquarters location', 'location', 'based in'],
    city: ['city', 'town'],
    country: ['country', 'nation'],
    founded: ['founded', 'founded year', 'year founded', 'established'],
    employees: ['employees', 'employee count', 'headcount', 'team size', 'staff'],
    funding: ['funding', 'funding details', 'funding information'],
    funding_stage: ['funding stage', 'investment stage', 'stage'],
    total_raised: ['total raised', 'total funding', 'amount raised', 'funding amount'],
    last_funding_date: ['last funding date', 'latest funding date', 'funding date', 'last round date'],
    open_eng_roles: ['open eng roles', 'open engineering roles', 'engineering roles', 'open roles', 'hiring'],
    recent_news: ['recent news', 'latest news', 'news', 'recent activity'],
    public_appearances: ['public appearances', 'appearances', 'podcasts', 'events', 'talks'],
    criteria_flags: ['flags criteria check', 'flags', 'criteria check', 'criteria', 'fit flags', 'company notes / flags', 'company notes'],
    contact: ['decision maker', 'decision maker name', 'decisionmaker', 'contact', 'contact name', 'person', 'founder', 'name', 'full name', 'prospect name', 'person name'],
    first_name: ['first name', 'firstname', 'given name'],
    last_name: ['last name', 'lastname', 'surname', 'family name'],
    title: ['title', 'job title', 'dm title', 'decision maker title', 'role', 'position', 'person role'],
    dm_linkedin: ['dm linkedin', 'decision maker linkedin', 'decisionmaker linkedin', 'contact linkedin', 'person linkedin', 'linkedin profile', 'linkedin url', 'linkedin_url', 'person linkedin url', 'profile url', 'person linkedin profile'],
    email: ['email', 'email address', 'dm email', 'decision maker email', 'work email', 'contact email'],
    phone: ['phone', 'phone number', 'dm phone', 'decision maker phone', 'mobile', 'telephone', 'whatsapp'],
    time_in_role: ['dm time in role', 'time in role', 'time in current role', 'tenure'],
    previous_roles: ['dm previous roles', 'previous roles', 'past roles', 'career history'],
    education: ['dm education', 'education', 'academic background', 'school'],
    notes: ['notes', 'extra context', 'additional notes', 'comments', 'person background / notes', 'person background', 'person source url', 'person source urls', 'dm background'],
    live_product: ['live product', 'live product (y/n)', 'has live product', 'product live'],
    founders: ['founders', 'founder names', 'co-founders', 'cofounders'],
    technical_lead: ['cto / technical co-founder', 'cto', 'technical co-founder', 'technical lead', 'cto / technical co-founder (y/n)'],
    source: ['company source url', 'company source urls', 'company source', 'source url', 'source urls'],
  };
  const GENERIC_ALIASES = new Set(['company', 'business', 'startup', 'organization', 'organisation', 'linkedin', 'contact', 'person', 'title', 'location', 'website', 'email', 'phone', 'education', 'notes', 'stage']);
  const headerScore = (header, alias) => {
    const h = headerKey(header), a = headerKey(alias);
    if (!h || !a) return 0;
    if (h === a) return 10000 + a.length;
    if (a.length >= 4 && h.includes(a) && !(GENERIC_ALIASES.has(a) && h !== a)) return 5000 + a.length;
    if (h.length >= 4 && a.includes(h) && !(GENERIC_ALIASES.has(h) && h !== a)) return 2500 + h.length;
    const ht = new Set(h.match(/[a-z]+/g) || []), at = (a.match(/[a-z]+/g) || []);
    const overlap = at.filter((x) => ht.has(x)).length;
    return overlap ? 1000 + overlap * 10 : 0;
  };
  let csvRows = [];
  let selectedSheet = '';
  let workbookSheets = [];
  const renderImportMapping = (file, rows, sheetName, sheets) => {
    csvRows = rows || [];
    selectedSheet = sheetName || '';
    workbookSheets = sheets || [];
    const cols = csvRows.length ? Object.keys(csvRows[0]) : [];
    const sheetPicker = workbookSheets.length ? `
      <div class="card pad-sm" style="margin-bottom:12px;background:var(--surface-2)">
        <label>Worksheets: ${workbookSheets.length}</label>
        <select id="csvsheet">
          ${workbookSheets.map((sh, i) => `<option value="${i}"${sh.name === selectedSheet ? ' selected' : ''}>${esc(sh.name)} — ${sh.rows.length} non-empty data rows</option>`).join('')}
        </select>
        <div class="small muted" style="margin-top:4px">Choose the worksheet you want to import. The importer initially selected the largest non-empty worksheet.</div>
      </div>` : '';
    const mapRoot = document.getElementById('csvmap');
    if (!cols.length) {
      mapRoot.innerHTML = sheetPicker + '<div class="empty small">This worksheet has no readable header row. Choose another worksheet above.</div>';
      const emptySheet = document.getElementById('csvsheet');
      if (emptySheet) emptySheet.onchange = () => {
        const pick = workbookSheets[+emptySheet.value];
        if (pick) renderImportMapping(file, pick.rows, pick.name, workbookSheets);
      };
      return;
    }
    const used = new Set();
    const guess = (fld) => {
      const aliases = HEADER_ALIASES[fld] || [fld];
      let best = { col: '', score: 0 };
      for (const col of cols) {
        if (used.has(col)) continue;
        const score = Math.max(...aliases.map((alias) => headerScore(col, alias)));
        if (score > best.score) best = { col, score };
      }
      if (best.score >= 2500) used.add(best.col);
      return best.col;
    };
    const guessed = {};
    FIELDS.forEach(([k]) => { guessed[k] = guess(k); });
    const mappedCount = Object.values(guessed).filter(Boolean).length;
    const ext = /\.xlsx$/i.test(file.name) ? 'Excel' : 'text';
    const sheetInfo = selectedSheet ? ` · worksheet: ${selectedSheet}` : '';
    document.getElementById('csvmsg').textContent = `${file.name}: ${csvRows.length} rows, ${cols.length} columns · ${ext} read${sheetInfo} · smart-mapped ${mappedCount} fields — review below`;
    mapRoot.innerHTML = `
      <div class="mt" style="border-top:1px solid var(--line);padding-top:12px">
        ${sheetPicker}
        <div class="grid3">
          ${FIELDS.map(([k, label]) => `
            <div><label>${esc(label)}</label>
              <select data-f="${k}"><option value="">— ignore / missing —</option>
                ${cols.map((c) => `<option value="${esc(c)}"${guessed[k] === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
              </select></div>`).join('')}
        </div>
        <div class="row mt">
          <div><label>Default follow-up cadence (days)</label>
            <input type="number" id="csvcad" value="${esc(s.default_cadence || '4')}" min="1" max="30" style="width:90px"></div>
          <div class="sp"></div>
          <button class="btn" id="csvcancel">Cancel</button>
          <button class="btn pri" id="csvimport">Import ${csvRows.length} rows</button>
        </div>
      </div>`;
    const sheetSelect = document.getElementById('csvsheet');
    if (sheetSelect) sheetSelect.onchange = () => {
      const pick = workbookSheets[+sheetSelect.value];
      if (pick) renderImportMapping(file, pick.rows, pick.name, workbookSheets);
    };
    document.getElementById('csvimport').onclick = async () => {
      const mapping = {};
      document.querySelectorAll('#csvmap [data-f]').forEach((sel) => { if (sel.value) mapping[sel.dataset.f] = sel.value; });
      if (!mapping.company && !mapping.domain && !mapping.website && !mapping.email) {
        toast('Map Company, Domain, Website, or Email so the company can be identified');
        return;
      }
      try {
        const r = await post('import/csv', { rows: csvRows, mapping, cadence: +document.getElementById('csvcad').value });
        toast(`Imported ${r.createdCompanies} companies, ${r.createdContacts} people` +
              (r.autoAssigned ? ` · ${r.autoAssigned} project matches` : '') +
              (r.skipped ? `, skipped ${r.skipped} duplicate/empty` : ''));
        document.getElementById('csvmap').innerHTML = '';
        document.getElementById('csvmsg').textContent = r.skipped
          ? `Import complete: ${r.createdCompanies} companies, ${r.createdContacts} people, ${r.autoAssigned || 0} project matches, ${r.skipped} skipped`
          : `Import complete: ${r.createdCompanies} companies, ${r.createdContacts} people, ${r.autoAssigned || 0} project matches`;
        refreshCounts();
      } catch (err) {
        document.getElementById('csvmsg').textContent = 'Import failed: ' + err.message;
      }
    };
    document.getElementById('csvcancel').onclick = () => {
      document.getElementById('csvmap').innerHTML = '';
      document.getElementById('csvmsg').textContent = '';
    };
  };
  document.getElementById('csvfile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const parsed = await parseSpreadsheetRows(f);
      renderImportMapping(f, parsed.rows, parsed.sheetName, parsed.sheets);
    } catch (err) {
      document.getElementById('csvmsg').textContent = 'Could not read file: ' + err.message;
      document.getElementById('csvmap').innerHTML = '';
    }
  };
}

/* ----------------------------------------------------------------- login */
function renderLogin(message) {
  appEl.innerHTML = `
  <div class="login">
    <h1 style="margin-top:0;font-size:20px">Origami Outreach CRM</h1>
    ${message ? `<div class="err">${esc(message)}</div>` : ''}
    <form id="loginform">
      <div class="f one"><div><label>Password</label><input type="password" name="key" autofocus></div></div>
      <button class="btn pri" style="width:100%">Unlock</button>
    </form>
  </div>`;
  document.getElementById('loginform').onsubmit = async (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    try {
      const r = await post('login', o);
      if (!r.ok) return renderLogin('Wrong password.');
      if (r.token) localStorage.setItem('ocrm_token', r.token);
      route();
    } catch (err) {
      renderLogin(err.message === 'wrong password' ? 'Wrong password.' : 'Could not sign in: ' + err.message);
    }
  };
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    const w = await api('whoami');
    AUTH_REQUIRED = !!w.auth_required;
    AUTH_CONFIGURED = !!w.configured;
    if (AUTH_REQUIRED && !w.authenticated) return renderLogin(w.configured ? '' : 'Authentication is not configured. Ask the administrator to configure the server secret.');
  } catch (e) {
    return renderLogin('Cannot reach the database: ' + e.message);
  }
  const tEl = document.getElementById('today');
  if (tEl) tEl.textContent = new Date().toISOString().slice(0, 10);
  startClock(); installPalette(); installShortcuts(); installQuickAdd(); refreshCounts();
  try {
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const s = await get('settings');
    if (mine && !s.user_tz) await post('settings', { user_tz: mine });
    if (mine) USER_TZ = s.user_tz || mine;
  } catch { /* non-fatal */ }
  if (!location.hash) location.hash = '#/jarvis';
  route();
}
window.addEventListener('hashchange', () => { closeSidebar(); route(); refreshCounts(); });

/* ------------------------------------------------------------------ clock */
function startClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const tick = () => {
    try {
      const tz = USER_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
      el.textContent = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date()) + ' local';
    } catch { el.textContent = ''; }
  };
  tick(); setInterval(tick, 30000);
}

/* -------------------------------------------------------- command palette */
const PALETTE = [
  { t: 'nav', label: 'Jarvis — today\'s plan', run: () => go('#/jarvis') },
  { t: 'nav', label: 'Tasks', run: () => go('#/tasks') },
  { t: 'nav', label: 'Pipeline board', run: () => go('#/pipeline') },
  { t: 'nav', label: 'Sequence Builder', run: () => go('#/sequences') },
  { t: 'nav', label: 'Prospects', run: () => go('#/people') },
  { t: 'nav', label: 'Outreach projects', run: () => go('#/projects') },
  { t: 'nav', label: 'Research', run: () => go('#/research') },
  { t: 'nav', label: 'AI copywriting', run: () => go('#/copywriting') },
  { t: 'nav', label: 'Inbox / Replies', run: () => go('#/inbox') },
  { t: 'nav', label: 'Companies', run: () => go('#/companies') },
  { t: 'nav', label: 'Templates', run: () => go('#/templates') },
  { t: 'nav', label: 'Analytics', run: () => go('#/analytics') },
  { t: 'nav', label: 'Settings & backup', run: () => go('#/settings') },
  { t: 'action', label: 'New company', run: () => openQuickAdd() },
];
async function runPalette() {
  const people = await get('people');
  const items = PALETTE.slice();
  for (const p of people.people.slice(0, 400)) {
    items.push({ t: 'person', label: p.name || '(unnamed)', sub: [p.title, p.company_name].filter(Boolean).join(' · '), run: () => go('#/contact/' + p.id) });
  }
  for (const c of await get('companies').then((r) => r.companies.slice(0, 300))) {
    items.push({ t: 'company', label: c.name, sub: c.domain || '', run: () => go('#/companies/' + c.id) });
  }
  const root = document.getElementById('palette-root');
  let sel = 0, filtered = items.slice(0, 40);
  const renderList = () => {
    const groups = {};
    filtered.forEach((it, i) => { (groups[it.t] = groups[it.t] || []).push({ it, i }); });
    let html = '';
    for (const g of Object.keys(groups)) {
      html += `<div class="grp">${g === 'nav' ? 'Go to' : g === 'action' ? 'Actions' : g === 'person' ? 'People' : 'Companies'}</div>`;
      for (const { it, i } of groups[g]) {
        html += `<div class="pal-item ${i === sel ? 'sel' : ''}" data-i="${i}">${esc(it.label)}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</div>`;
      }
    }
    if (!filtered.length) html = '<div class="empty">No matches</div>';
    root.querySelector('.list').innerHTML = html;
    root.querySelectorAll('.pal-item').forEach((el) => {
      el.onmouseenter = () => { sel = +el.dataset.i; renderList(); };
      el.onclick = () => { close(); filtered[sel].run(); };
    });
  };
  root.innerHTML = `<div class="palette-wrap"><div class="palette">
      <input id="pal-q" placeholder="Search people, companies, or jump to a page…" autocomplete="off">
      <div class="list"></div>
      <div class="foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></div>
    </div></div>`;
  const q = root.querySelector('#pal-q');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, filtered.length - 1); renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderList(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (filtered[sel]) { close(); filtered[sel].run(); } e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  };
  q.oninput = () => {
    const v = q.value.toLowerCase().trim();
    filtered = (v ? items.filter((i) => (i.label + ' ' + (i.sub || '')).toLowerCase().includes(v)) : items).slice(0, 60);
    sel = 0; renderList();
  };
  document.addEventListener('keydown', onKey);
  root.querySelector('.palette-wrap').onclick = (e) => { if (e.target.classList.contains('palette-wrap')) close(); };
  q.focus(); renderList();
}
function go(hash) { location.hash = hash; }
function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('open');
}
function installPalette() {
  const box = document.getElementById('globalsearch');
  const burger = document.getElementById('burger');
  const sidebar = document.getElementById('sidebar');
  if (box) box.onfocus = () => { box.blur(); runPalette(); };
  if (burger) burger.onclick = (e) => {
    e.stopPropagation();
    if (sidebar) sidebar.classList.toggle('open');
  };
  document.querySelectorAll('#nav .navitem').forEach((item) => item.addEventListener('click', closeSidebar));
  document.addEventListener('click', (e) => {
    if (!sidebar || !sidebar.classList.contains('open')) return;
    if (window.innerWidth > 900) return;
    if (sidebar.contains(e.target) || (burger && burger.contains(e.target))) return;
    closeSidebar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });
}

/* ---------------------------------------------------------- quick-add modal */
async function openQuickAdd() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="palette-wrap" id="qa-wrap"><div class="palette" style="width:min(460px,94vw)">
    <div style="padding:16px">
      <h2 style="margin-bottom:4px">Add a company</h2>
      <p class="sub small" style="margin-bottom:12px">Domain is enough — we detect the city, country and timezone from the HQ.</p>
      <div class="f one">
        <div><label>Company name</label><input id="qa-name" placeholder="Jamble" autocomplete="off"></div>
        <div><label>Domain</label><input id="qa-domain" placeholder="jamble.app" autocomplete="off"></div>
      </div>
      <div class="f one"><div><label>HQ (city, country)</label><input id="qa-hq" placeholder="Paris, France" autocomplete="off"></div></div>
      <div class="f one"><div><label>Sub-niche</label><input id="qa-niche" placeholder="P2P fashion resale"></div></div>
      <div id="qa-msg" class="small muted" style="min-height:18px;margin-bottom:8px"></div>
      <div class="row"><div class="sp"></div>
        <button class="btn" id="qa-cancel">Cancel</button>
        <button class="btn pri" id="qa-save">Add company</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('qa-cancel').onclick = close;
  root.querySelector('#qa-wrap').onclick = (e) => { if (e.target.id === 'qa-wrap') close(); };
  document.getElementById('qa-name').focus();
  const hq = document.getElementById('qa-hq');
  hq.onblur = async () => {
    if (!hq.value.trim()) return;
    const d = await post('detect', { hq: hq.value });
    document.getElementById('qa-msg').textContent = d.timezone
      ? `Detected ${d.city ? d.city + ', ' : ''}${d.country} · ${d.timezone} · now ${d.localTime} there`
      : 'Could not detect a timezone — you can set it on the company page.';
  };
  const save = async () => {
    const name = document.getElementById('qa-name').value.trim();
    if (!name) { document.getElementById('qa-name').focus(); return; }
    const payload = { name, domain: document.getElementById('qa-domain').value.trim(),
                      hq: hq.value.trim(), sub_niche: document.getElementById('qa-niche').value.trim() };
    await post('companies', payload);
    close(); toast('Company added');
    location.hash = '#/companies'; route(); refreshCounts();
  };
  document.getElementById('qa-save').onclick = save;
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(); });
}
function installQuickAdd() {
  document.getElementById('quickadd').onclick = openQuickAdd;
}

/* ------------------------------------------------------------- shortcuts */
function installShortcuts() {
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''));
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); runPalette(); return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); runPalette(); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault(); openQuickAdd(); }
    else if (e.key.toLowerCase() === 'g') { e.preventDefault(); go('#/jarvis'); }
  });
}

boot();

/* ------------------------------------------------------------------ JARVIS */
function planCard(i) {
  const c = i.contact, co = i.company;
  const draft = i.draft || { subject: '', body: '', templateId: null, templateName: '', channel: 'email' };
  const full = (draft.subject ? draft.subject + '\n\n' : '') + (draft.body || '');
  return `
  <div class="panel tight" style="margin-bottom:10px">
    <div style="display:flex;gap:14px;justify-content:space-between;align-items:flex-start;padding:12px 14px;flex-wrap:wrap">
      <div style="min-width:240px">
        <div class="row tight" style="gap:7px;align-items:center">
          <a href="#/contact/${c.id}"><b>${esc(c.name || '(unnamed)')}</b></a>
          ${scorePill(i)}
          ${i.sequence ? `<span class="b plain" title="${esc(i.sequence.name)} — replies stop the sequence">${esc(i.sequence.name)} · ${i.sequence.step}/${i.sequence.of}</span>` : ''}
        </div>
        <div class="sub2">${esc(c.title || '')} · <a href="#/companies/${co.id}">${esc(co.name)}</a></div>
        <div class="sub2">${esc(i.reason)}</div>
        ${(i.scoreWhy || []).length ? `<div class="chips" style="margin-top:5px">${i.scoreWhy.slice(0, 5).map((w) => `<span class="chip static">${esc(w)}</span>`).join('')}</div>` : ''}
      </div>
      <div style="text-align:right;white-space:nowrap">
        <div>${localLine(i.local, co.timezone)}</div>
        <div style="margin-top:5px">${windowBadge(i.window)}</div>
      </div>
    </div>
    <details style="border-top:1px solid var(--line)">
      <summary style="padding:9px 14px;cursor:pointer;font-size:13.5px;color:var(--muted)">
        ${esc(draft.templateName || 'No template')} · touch ${i.touch + 1} · next follow-up +${i.nextCadence}d
      </summary>
      <div style="padding:0 14px 14px">
        <pre class="tpl" style="white-space:pre-wrap;background:#fbfcfe;color:var(--ink);border:1px solid var(--line)">${esc(full) || '<span class="muted">No template yet — add one in Templates.</span>'}</pre>
        <div class="row" style="margin-top:10px">
          <button class="btn pri sm" data-log="${c.id}">Log as sent</button>
          <button class="btn sm" data-copy="${c.id}">Copy draft</button>
          <button class="btn sm" data-tracked="${c.id}">Copy with tracked link</button>
          <a class="btn sm" href="#/contact/${c.id}">Open person →</a>
          <span class="muted" data-msg="${c.id}"></span>
        </div>
      </div>
    </details>
  </div>`;
}

async function renderJarvis() {
  const [plan, ins, guard] = await Promise.all([get('plan'), get('insights'), get('guardrails').catch(() => null)]);
  const t = ins.totals;
  const draftById = {};
  for (const list of [plan.sendNow, plan.today, plan.later]) for (const i of list) draftById[i.contact.id] = i;

  const rate = t.rate;
  const rateCls = rate >= 15 ? 'green' : rate >= 8 ? '' : 'red';

  appEl.innerHTML = `
  <h1>Jarvis</h1>
  <p class="sub">
    ${plan.userTime ? `Your time: <b>${esc(plan.userTime.weekday)} ${esc(plan.userTime.time)}</b> · ` : ''}
    ${plan.totals.sendNow} people are inside their send window right now,
    ${plan.totals.today} open later today, ${plan.totals.later} are waiting for a working day.
  </p>

  <div class="stats">
    ${stat(plan.totals.sendNow, 'Send now', 'green')}
    ${stat(plan.totals.today, 'Later today')}
    ${stat(plan.totals.later, 'Waiting (weekend/hours)')}
    ${stat(t.contacted, 'People contacted')}
    ${stat(t.sent, 'Messages sent')}
    ${stat(rate + '%', 'Reply rate', rateCls)}
    ${stat(t.replied, 'Replied', 'green')}
    ${stat(t.neverTouched, 'Never touched')}
  </div>

  ${guard ? `<div class="card pad mb" style="border-color:${guard.level === 'over' ? 'var(--bad)' : guard.level === 'near' ? 'var(--warn, #B78103)' : 'var(--line)'}">
    <div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0">Deliverability guardrail</h3>
        <p class="sub small" style="margin:3px 0 0">
          ${guard.sentToday} sent today · ${guard.remaining} left of ${guard.effective}
          ${guard.rampCap !== null && guard.rampCap < guard.cap
            ? `· <b>domain is ${guard.weeks} week${guard.weeks === 1 ? '' : 's'} old, so the ramp caps you at ${guard.rampCap}/day</b>`
            : ''}
        </p>
      </div>
      <div class="row tight">
        <span class="b ${guard.level === 'over' ? 'passed' : guard.level === 'near' ? 'due' : 'replied'}">${guard.level === 'over' ? 'at the cap' : guard.level === 'near' ? 'approaching cap' : 'healthy'}</span>
        <a class="btn sm" href="#/settings">Adjust</a>
      </div>
    </div>
    <div class="bar mt" style="height:8px"><i class="${guard.level === 'over' ? '' : guard.level === 'near' ? 'warn' : 'ok'}"
      style="width:${guard.pct}%"></i></div>
    <p class="small faint mt">Safe ceiling is 20–50 cold emails per mailbox per day; a domain under six weeks old
      should ramp from 10. Spikes hurt more than volume. Bounce rate so far: ${guard.bounceRate}%.</p>
  </div>` : ''}

  <h2>Send now <span class="muted" style="font-size:14px">— it's working hours where they are</span></h2>
  ${plan.sendNow.length ? plan.sendNow.map(planCard).join('')
    : '<div class="panel empty">Nobody is inside their send window at this exact moment. Next window opens below.</div>'}

  <h2>Later today <span class="muted" style="font-size:14px">— their window opens in a few hours</span></h2>
  ${plan.today.length ? plan.today.map(planCard).join('') : '<div class="panel empty">Nothing else today.</div>'}

  <h2>Waiting <span class="muted" style="font-size:14px">— weekend, public holiday, or outside hours there</span></h2>
  ${plan.later.length ? plan.later.slice(0, 20).map(planCard).join('') : '<div class="panel empty">Nothing waiting.</div>'}

  <h2>What's working</h2>
  <div class="panel">
    ${ins.recommendations.length ? ins.recommendations.map((r) => `
      <div style="padding:9px 0;border-bottom:1px solid #f0f2f5">
        <span class="b ${r.level === 'good' ? 'replied' : r.level === 'warn' ? 'due' : 'new'}">${esc(r.level)}</span>
        <b style="margin-left:7px">${esc(r.title)}</b>
        <div class="muted" style="margin-top:3px">${esc(r.detail)}</div>
      </div>`).join('') : '<div class="muted">No recommendations yet.</div>'}
  </div>

  ${(ins.byChannel.length || ins.byWeekday.length) ? `
  <div class="grid2">
    <div class="panel"><h3>By channel</h3>
      <table><thead><tr><th>Channel</th><th>Sent</th><th>Replies</th><th>Rate</th></tr></thead><tbody>
      ${ins.byChannel.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.sent}</td>
        <td class="mono">${r.replies}</td><td class="mono">${r.rate}%</td></tr>`).join('')}
      </tbody></table></div>
    <div class="panel"><h3>By day sent</h3>
      <table><thead><tr><th>Day</th><th>Sent</th><th>Replies</th><th>Rate</th></tr></thead><tbody>
      ${ins.byWeekday.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.sent}</td>
        <td class="mono">${r.replies}</td><td class="mono">${r.rate}%</td></tr>`).join('')}
      </tbody></table></div>
    <div class="panel"><h3>By touch number</h3>
      <table><thead><tr><th>Touch</th><th>Sent</th><th>Replies</th><th>Rate</th></tr></thead><tbody>
      ${ins.byTouch.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.sent}</td>
        <td class="mono">${r.replies}</td><td class="mono">${r.rate}%</td></tr>`).join('')}
      </tbody></table></div>
    ${ins.byTemplate.length ? `<div class="panel"><h3>By template</h3>
      <table><thead><tr><th>Template</th><th>Sent</th><th>Replies</th><th>Rate</th></tr></thead><tbody>
      ${ins.byTemplate.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.sent}</td>
        <td class="mono">${r.replies}</td><td class="mono">${r.rate}%</td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </div>` : ''}`;

  // wire the actions
  appEl.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      const i = draftById[+b.getAttribute('data-copy')];
      const txt = ((i.draft && i.draft.subject ? i.draft.subject + '\n\n' : '') + ((i.draft && i.draft.body) || ''));
      navigator.clipboard.writeText(txt).then(() => toast('Draft copied'));
    };
  });
  appEl.querySelectorAll('[data-tracked]').forEach((b) => {
    b.onclick = async () => {
      const i = draftById[+b.getAttribute('data-tracked')];
      const url = prompt('Link to track (clicks are logged, opens are not — Apple makes them fiction):',
        'https://origami.consulting');
      if (!url) return;
      const r = await post('track/link', { contact_id: i.contact.id, url });
      const tracked = location.origin + '/api/track/c/' + r.token;
      const txt = ((i.draft && i.draft.subject ? i.draft.subject + '\n\n' : '') + ((i.draft && i.draft.body) || ''))
        + '\n\n' + tracked;
      navigator.clipboard.writeText(txt).then(() => toast('Copied with a tracked link'));
    };
  });
  appEl.querySelectorAll('[data-log]').forEach((b) => {
    b.onclick = async () => {
      const i = draftById[+b.getAttribute('data-log')];
      if (!i.draft) { toast('No template to log'); return; }
      if (!confirm(`Log "${i.draft.subject || i.draft.templateName}" as sent to ${i.contact.name}?`)) return;
      await post('contacts/' + i.contact.id + '/messages', {
        channel: i.draft.channel, subject: i.draft.subject, body: i.draft.body, template_id: i.draft.templateId,
      });
      toast('Logged — next follow-up scheduled on their local calendar');
      route();
    };
  });
}

/* ================================================================= PEOPLE */
const STAGES = [
  ['new', 'New'], ['active', 'Contacted'], ['replied', 'Replied'],
  ['meeting', 'Meeting'], ['proposal', 'Proposal'], ['won', 'Won'], ['lost', 'Lost'], ['passed', 'Passed'],
  ['paused', 'Paused'], ['unsubscribed', 'Unsubscribed'], ['do_not_contact', 'Do not contact'], ['bounced', 'Bounced'],
];
let SEL = new Set();
let COMPANY_SEL = new Set();

async function renderPeople() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '', st = params.get('status') || '', tag = params.get('tag') || '';
  const market = params.get('market') || '', role = params.get('role') || '';
  const signal = params.get('signal') || '', time = params.get('time') || '';
  const timezone = params.get('timezone') || '', min_icp = params.get('min_icp') || '', max_icp = params.get('max_icp') || '';
  const sort = params.get('sort') || 'score';
  const filterState = { q, status: st, tag, market, role, signal, time, timezone, min_icp, max_icp, sort };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filterState)) if (value) query.set(key, value);
  const [data, seqs] = await Promise.all([
    get('people?' + query.toString()),
    get('sequences'),
  ]);
  const people = sortPeople(data.people, sort);
  SEL = new Set();
  const peopleUrl = (overrides = {}) => {
    const next = Object.assign({}, filterState, overrides);
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value) qs.set(key, value);
    return '#/people' + (qs.toString() ? '?' + qs.toString() : '');
  };
  const th = (key, label) => {
    const active = sort.replace(/_asc$/, '') === key;
    const ascending = sort.endsWith('_asc');
    const next = active && !ascending ? key + '_asc' : key;
    return `<a class="th ${active ? 'on' : ''}" href="${peopleUrl({ sort: next })}">${label}${active ? (ascending ? ' ↑' : ' ↓') : ''}</a>`;
  };
  const roleLabels = { founder: 'Founder / CEO', technology: 'Technology', product: 'Product', sales_growth: 'Sales / Growth', operations: 'Operations / Finance', executive: 'Other executive', other: 'Other title', unknown: 'Title missing' };
  const signalLabels = { funding: 'Funding', hiring: 'Hiring', news: 'Recent news', replied: 'Replied', clicked: 'Clicked link', untouched: 'Untouched', overdue: 'Overdue' };
  const signalOptions = Object.entries(signalLabels);
  const timeLabels = { open: 'Send window open now', closed: 'Outside send window', weekend: 'Local weekend', holiday: 'Local holiday', unknown: 'Timezone unknown' };
  const filterSelect = (name, current, choices, firstLabel) => `<select name="${name}" style="min-width:150px;max-width:220px"><option value="">${firstLabel}</option>${choices.map(([v, label]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;

  appEl.innerHTML = `
  <div class="page-head">
    <div><h1>Prospects &amp; market segments</h1><p class="sub">${people.length} of ${data.total || people.length} decision makers · filter by status, ICP score, timezone, market and buying signals</p></div>
    <div class="row"><label style="margin:0">Sequence for quick add<select id="people-sequence" style="min-width:190px"><option value="">Choose active sequence</option>${(seqs.sequences||[]).filter((sq)=>Number(sq.active)).map((sq)=>`<option value="${sq.id}">${esc(sq.name)}</option>`).join('')}</select></label></div>
  </div>

  <div class="card pad mb">
    <h3 style="margin-top:0">Add a prospect manually</h3>
    <form class="row" id="manualprospect" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div><label>Name</label><input name="name" required placeholder="Avery Chen"></div>
      <div><label>Work email (optional)</label><input name="email" type="email" placeholder="avery@company.com"></div>
      <div><label>Company</label><input name="company" required placeholder="Company name"></div>
      <div><label>Company domain / website</label><input name="domain" placeholder="company.com"></div>
      <div><label>Title</label><input name="title" placeholder="CTO"></div>
      <div><label>LinkedIn profile URL (stored only)</label><input name="linkedin_url" placeholder="linkedin.com/in/…"></div>
      <button class="btn pri">Add &amp; queue enrichment</button>
    </form>
  </div>

  <div class="card pad mb">
    <form class="row" id="pfilter" style="gap:8px;flex-wrap:wrap">
      <input name="q" placeholder="Search name, title, company…" value="${esc(q)}" style="min-width:210px;max-width:280px">
      ${filterSelect('status', st, STAGES, 'All stages')}
      ${filterSelect('market', market, (data.markets || []).map((m) => [m.key, m.label]), 'All markets / locations')}
      ${filterSelect('role', role, Object.entries(roleLabels), 'All job-title groups')}
      ${filterSelect('signal', signal, signalOptions, 'Any buying signal')}
      ${filterSelect('time', time, Object.entries(timeLabels), 'Any local send time')}
      ${filterSelect('timezone', timezone, (data.timezones || []).map((zone) => [zone,zone]), 'Any timezone')}
      <input name="min_icp" type="number" min="0" max="100" placeholder="Min ICP" value="${esc(min_icp)}" style="width:100px">
      <input name="max_icp" type="number" min="0" max="100" placeholder="Max ICP" value="${esc(max_icp)}" style="width:100px">
      <input type="hidden" name="tag" value="${esc(tag)}">
      <input type="hidden" name="sort" value="${esc(sort)}">
      <button class="btn pri">Apply segment</button>
      <a class="btn" href="#/people">Clear</a>
    </form>
    <p class="small muted" style="margin:10px 0 0">Segments are encoded in the page URL so you can bookmark or share a saved filter. “Send window” uses each prospect’s local timezone; it is a timing cue, not an automatic send.</p>
    ${data.tags.length ? `<div class="chips mt"><a class="chip ${!tag ? 'on' : ''}" href="${peopleUrl({ tag: '' })}">All tags</a>${data.tags.map((t) => `<a class="chip ${t.name === tag ? 'on' : ''}" href="${peopleUrl({ tag: t.name })}">${esc(t.name)}</a>`).join('')}</div>` : ''}
  </div>

  <div class="tbl-wrap">
    <div class="tbl-scroll"><table>
      <thead><tr>
        <th style="width:30px"><input type="checkbox" class="cb" id="selall"></th>
        <th>${th('name', 'Person')}</th><th>${th('title', 'Job title')}</th><th>${th('company', 'Company')}</th><th>${th('market', 'Market')}</th><th>${th('stage', 'Stage')}</th>
        <th>${th('score', 'Lead score')}</th><th>${th('icp', 'ICP score')}</th><th>Enrichment</th><th>${th('local', 'Local time')}</th><th>${th('signal_sort', 'Signals')}</th>
        <th>${th('next', 'Next')}</th><th>${th('touches', 'Touches')}</th><th>Tags</th><th></th>
      </tr></thead><tbody>
      ${people.map((p) => `
        <tr data-id="${p.id}">
          <td><input type="checkbox" class="cb selcb" value="${p.id}"></td>
          <td><a class="nm" href="#/contact/${p.id}">${esc(p.name || '(unnamed)')}</a></td>
          <td>${esc(p.title || 'Title missing')}<div class="sub2">${esc(roleLabels[p.role_family] || roleLabels.unknown)}</div></td>
          <td><a href="#/companies/${p.company_id}">${esc(p.company_name)}</a>
              <div class="sub2">${esc(p.sub_niche || '')}</div></td>
          <td>${esc(p.market_label || 'Unknown location')}<div class="sub2">${esc(p.timezone || 'timezone not set')}</div></td>
          <td><span class="b ${p.status}">${esc(p.status)}</span>${p.sequence_name ? `<div class="sub2">${esc(p.sequence_name)} · step ${(p.step_index || 0) + 1}</div>` : ''}</td>
          <td>${scorePill(p)}</td>
          <td style="min-width:170px"><b>${p.icp_score !== null && p.icp_score !== undefined ? `${Number(p.icp_score)}/100` : '—'}</b><div class="sub2" title="${esc(p.icp_reason || '')}">${esc(p.icp_reason || 'No ICP assessment yet')}</div></td>
          <td style="min-width:150px"><span class="b ${p.enrichment_status === 'completed' ? 'replied' : p.enrichment_status === 'failed' ? 'passed' : 'plain'}">${esc(p.enrichment_status || 'not queued')}</span>
            ${p.enrichment_status ? `<div class="bar mt" style="height:5px"><i style="width:${Math.max(0,Math.min(100,p.enrichment_progress || 0))}%"></i></div><div class="sub2">${esc(p.enrichment_detail || p.enrichment_stage || '')}</div>` : ''}
            ${p.email_discovery_status === 'needs_manual_email' ? '<div class="sub2"><b>Needs manual email</b></div>' : ''}
            ${['queued','enriching'].includes(p.enrichment_status) ? '<button class="btn xs" disabled>Enrichment running</button>' : `<button class="btn xs" data-requeue="${p.id}">Enrich now</button>`}</td>
          <td>${p.local ? `<span class="mono">${esc(p.local.time)}</span> <span class="sub2">${esc(p.local.weekday.slice(0, 3))}</span>` : '<span class="faint">—</span>'}
              <div>${windowBadge(p.window)}</div></td>
          <td>${(p.signals || []).length ? p.signals.map((key) => `<span class="b plain" title="Stored CRM signal">${esc(signalLabels[key] || key)}</span>`).join(' ') : '<span class="faint">No signal logged</span>'}</td>
          <td class="mono">${esc(p.next_action || '—')}</td>
          <td class="mono">${p.touch_count}</td>
          <td>${(p.tags || []).map((t) => `<span class="b plain">${esc(t)}</span>`).join(' ')}</td>
          <td><a class="btn sm" href="#/contact/${p.id}">Open</a> <button class="btn xs" data-expand-research="${p.id}">Research</button> <button class="btn xs" data-add-sequence="${p.id}">Add to sequence</button></td>
        </tr>
        <tr id="research-row-${p.id}" hidden><td colspan="15"><div class="card pad-sm"><b>Latest research summary</b><p style="white-space:pre-wrap">${esc(p.research_summary || 'No research summary saved yet.')}</p><div><b>ICP reason:</b> ${esc(p.icp_reason || 'No ICP assessment yet.')}</div></div></td></tr>`).join('')}
      </tbody></table></div>
  </div>
  ${people.length ? '' : '<div class="empty"><div class="big">👤</div>No people match this segment. Try widening your filters or add decision makers on a company page.</div>'}
  <div id="bulk-root"></div>`;

  qsa('[data-requeue]').forEach((button) => button.onclick = async () => {
    button.disabled = true; button.textContent = 'Running…';
    try { const result = await post('contacts/' + button.dataset.requeue + '/enrich', { run_now:true }); toast(result.processed ? 'Enrichment finished; review the updated ICP and research' : 'Queued, but the hourly cap or provider setup prevented an immediate run'); route(); }
    catch (err) { toast(err.message); button.disabled = false; button.textContent = 'Enrich now'; }
  });
  qsa('[data-expand-research]').forEach((button) => button.onclick = () => {
    const row = document.getElementById('research-row-' + button.dataset.expandResearch);
    if (row) { row.hidden = !row.hidden; button.textContent = row.hidden ? 'Research' : 'Hide research'; }
  });
  qsa('[data-add-sequence]').forEach((button) => button.onclick = async () => {
    const sequenceId = document.getElementById('people-sequence')?.value;
    if (!sequenceId) { toast('Choose an active sequence first'); return; }
    button.disabled = true;
    try {
      const result = await post(`sequences/${sequenceId}/enroll`, { contact_ids:[Number(button.dataset.addSequence)] });
      toast(result.enrolled ? 'Prospect added to sequence' : `Not added (${result.suppressed || 0} suppressed or ineligible)`);
      route();
    } catch (err) { toast(err.message); button.disabled = false; }
  });
  document.getElementById('manualprospect').onsubmit = async (e) => {
    e.preventDefault();
    try { const result = await post('prospects', formObject(e.target)); toast('Prospect added to enrichment queue'); location.hash = '#/contact/' + result.id; route(); }
    catch (err) { toast(err.message); }
  };
  document.getElementById('pfilter').onsubmit = (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    const qs = new URLSearchParams();
    for (const key of ['q', 'status', 'tag', 'market', 'role', 'signal', 'time', 'timezone', 'min_icp', 'max_icp', 'sort']) if (o[key]) qs.set(key, o[key]);
    location.hash = '#/people' + (qs.toString() ? '?' + qs.toString() : '');
  };
  document.getElementById('selall').onchange = (e) => {
    document.querySelectorAll('.selcb').forEach((c) => { c.checked = e.target.checked; });
    SEL.clear();
    if (e.target.checked) document.querySelectorAll('.selcb').forEach((c) => SEL.add(+c.value));
    drawBulk(seqs.sequences);
  };
  document.querySelectorAll('.selcb').forEach((c) => {
    c.onchange = () => {
      if (c.checked) SEL.add(+c.value); else SEL.delete(+c.value);
      drawBulk(seqs.sequences);
    };
  });
}
function sortPeople(list, sort) {
  const arr = list.slice();
  const desc = !/_asc$/.test(sort);
  const key = sort.replace(/_asc$/, '');
  const cmp = {
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
    company: (a, b) => String(a.company_name || '').localeCompare(String(b.company_name || '')),
    market: (a, b) => String(a.market_label || '').localeCompare(String(b.market_label || '')),
    local: (a, b) => String(a.local ? a.local.time : '99:99').localeCompare(String(b.local ? b.local.time : '99:99')),
    signal_sort: (a, b) => ((a.signals || []).length - (b.signals || []).length),
    stage: (a, b) => String(a.status).localeCompare(String(b.status)),
    score: (a, b) => (a.score || 0) - (b.score || 0),
    icp: (a, b) => (Number(a.icp_score ?? -1) - Number(b.icp_score ?? -1)),
    next: (a, b) => String(a.next_action || '9999-99-99').localeCompare(String(b.next_action || '9999-99-99')),
    touches: (a, b) => (a.touch_count || 0) - (b.touch_count || 0),
  }[key];
  if (!cmp) return arr;
  arr.sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
  return arr;
}
function scorePill(p) {
  if (p.score === undefined) {
    // people endpoint doesn't score; derive a light local score
    const n = (p.email ? 10 : 0) + (p.status === 'replied' ? 25 : p.status === 'meeting' ? 30 : 0) + (p.touch_count ? 4 : 0);
    return `<span class="score ${n >= 25 ? 'hi' : n >= 10 ? 'mid' : 'lo'}">${n}</span>`;
  }
  return `<span class="score ${p.scoreBand}">${p.score}</span>`;
}
function drawBulk(seqs) {
  const root = document.getElementById('bulk-root');
  if (!root) return;
  if (!SEL.size) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="bulkbar">
    <span class="n">${SEL.size} selected</span>
    <div class="sp" style="flex:1"></div>
    <button class="btn sm" data-b="snooze" data-days="3">Snooze 3d</button>
    <button class="btn sm" data-b="snooze" data-days="7">Snooze 7d</button>
    <select id="bk-seq" class="btn sm" style="max-width:170px">
      <option value="">Enrol in…</option>
      ${(seqs || []).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
    </select>
    <select id="bk-status" class="btn sm" style="max-width:140px">
      <option value="">Set stage…</option>
      ${STAGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
    </select>
    <input id="bk-tag" placeholder="Add tag" class="btn sm" style="max-width:120px">
    <button class="btn sm danger" data-b="delete">Remove</button>
    <button class="btn sm" data-b="clear">Clear</button>
  </div>`;
  const ids = () => Array.from(SEL);
  root.querySelectorAll('[data-b]').forEach((b) => {
    b.onclick = async () => {
      const op = b.dataset.b;
      if (op === 'clear') { SEL.clear(); root.innerHTML = ''; route(); return; }
      if (op === 'delete' && !confirm(`Remove ${SEL.size} people and their message history?`)) return;
      if (op === 'snooze') await post('bulk', { target: 'contacts', op: 'snooze', ids: ids(), days: +b.dataset.days });
      if (op === 'delete') await post('bulk', { target: 'contacts', op: 'delete', ids: ids() });
      toast(op === 'delete' ? 'Removed' : 'Updated');
      SEL.clear(); route(); refreshCounts();
    };
  });
  const sq = root.querySelector('#bk-seq');
  sq.onchange = async () => {
    if (!sq.value) return;
    await post('bulk', { target: 'contacts', op: 'enroll', ids: ids(), sequence_id: +sq.value });
    toast('Enrolled'); SEL.clear(); route(); refreshCounts();
  };
  const stsel = root.querySelector('#bk-status');
  stsel.onchange = async () => {
    if (!stsel.value) return;
    await post('bulk', { target: 'contacts', op: 'status', ids: ids(), value: stsel.value });
    toast('Stage updated'); SEL.clear(); route(); refreshCounts();
  };
  const tg = root.querySelector('#bk-tag');
  tg.onkeydown = async (e) => {
    if (e.key !== 'Enter' || !tg.value.trim()) return;
    await post('bulk', { target: 'contacts', op: 'tag', ids: ids(), tag_name: tg.value.trim() });
    toast('Tagged'); SEL.clear(); route(); refreshCounts();
  };
}

function drawCompanyBulk() {
  const root = document.getElementById('company-bulk-root');
  if (!root) return;
  if (!COMPANY_SEL.size) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="bulkbar">
    <span class="n">${COMPANY_SEL.size} companies selected</span>
    <div class="sp" style="flex:1"></div>
    <button class="btn sm danger" id="delete-selected-companies">Delete selected companies</button>
    <button class="btn sm" id="clear-selected-companies">Clear</button>
  </div>`;
  const ids = () => Array.from(COMPANY_SEL);
  root.querySelector('#clear-selected-companies').onclick = () => {
    COMPANY_SEL.clear();
    document.querySelectorAll('.co-selcb').forEach((c) => { c.checked = false; });
    const all = document.getElementById('co-selall');
    if (all) all.checked = false;
    root.innerHTML = '';
  };
  root.querySelector('#delete-selected-companies').onclick = async () => {
    const count = COMPANY_SEL.size;
    if (!confirm(`Delete ${count} compan${count === 1 ? 'y' : 'ies'} and all associated people, messages, tasks and activity? This cannot be undone.`)) return;
    try {
      const r = await post('bulk', { target: 'companies', op: 'delete', ids: ids() });
      toast(`Deleted ${r.affected || count} compan${(r.affected || count) === 1 ? 'y' : 'ies'}`);
      COMPANY_SEL.clear();
      route();
      refreshCounts();
    } catch (e) {
      toast('Delete failed: ' + e.message);
    }
  };
}

/* =============================================================== PIPELINE */
async function renderPipeline() {
  const data = await get('people');
  const people = data.people.filter((p) => p.status !== 'paused');
  const cols = STAGES;
  appEl.innerHTML = `
  <div class="page-head">
    <div><h1>Pipeline</h1><p class="sub">Drag a card to move someone. ${people.length} people in play.</p></div>
  </div>
  <div class="kanban" id="kb">
    ${cols.map(([key, label]) => {
      const list = people.filter((p) => p.status === key);
      return `<div class="kcol" data-stage="${key}">
        <h4><span class="dot stage-${key}"></span>${label}<span class="n">${list.length}</span></h4>
        <div class="kbody">
          ${list.map((p) => `<div class="kcard" draggable="true" data-id="${p.id}">
            <span class="nm">${esc(p.name || '(unnamed)')}</span>
            <span class="co">${esc(p.company_name)}</span>
            <div class="meta">
              ${scorePill(p)}
              ${p.local ? `<span class="b plain">${esc(p.local.time)}</span>` : ''}
              ${p.next_action ? `<span class="mono">${esc(p.next_action)}</span>` : ''}
            </div></div>`).join('')}
          ${list.length ? '' : '<div class="small faint" style="padding:8px 4px">Drop here</div>'}
        </div></div>`;
    }).join('')}
  </div>`;
  let dragId = null;
  appEl.querySelectorAll('.kcard').forEach((c) => {
    c.ondragstart = () => { dragId = +c.dataset.id; };
    c.ondragend = () => { dragId = null; };
  });
  appEl.querySelectorAll('.kcol').forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('dragover'); };
    col.ondragleave = () => col.classList.remove('dragover');
    col.ondrop = async (e) => {
      e.preventDefault(); col.classList.remove('dragover');
      if (!dragId) return;
      await post('contacts/' + dragId + '/status', { status: col.dataset.stage });
      toast('Moved to ' + col.dataset.stage);
      route(); refreshCounts();
    };
  });
}

/* ================================================================ RESEARCH */
async function renderCopywriting() {
  const data = await get('copywriting');
  const jobs = data.jobs || [];
  const queued = jobs.filter((j) => j.status === 'queued').length;
  appEl.innerHTML = `<h1>AI copywriting</h1>
    <p class="sub">Four pre-generated emails per queued prospect. Drafts are AI-generated, editable, and scored. Sending begins only after you connect Gmail and explicitly schedule the sequence.</p>
    <div class="row" style="margin:14px 0"><div class="stat"><b>${queued}</b><span>queued for generation</span></div><span class="sp"></span><button class="btn pri" id="run-copywriting" ${queued ? '' : 'disabled'}>Generate queued drafts</button><span class="small muted" id="copywriting-run-status"></span></div>
    ${jobs.length ? `<div class="stack">${jobs.map((j) => `<div class="panel row" style="align-items:center"><div><a href="#/contact/${j.contact_id}"><b>${esc(j.contact_name)}</b></a><div class="small muted">${esc(j.title || '')} · ${esc(j.company_name || '')}</div></div><span class="sp"></span>${badge(j.status === 'ready' || j.status === 'scheduled' ? 'replied' : j.status === 'needs_review' || j.status === 'failed' ? 'due' : 'plain', esc(j.status))}<span class="small muted">${j.draft_count}/4 drafts${j.min_score !== null ? ` · lowest ${j.min_score}/100` : ''}</span><a class="btn sm" href="#/contact/${j.contact_id}">Open drafts →</a></div>`).join('')}</div>` : '<div class="empty">No copywriting jobs yet. Add a research note to a prospect, then queue their drafts from the contact page.</div>'}
    <div class="panel"><h3>Quality and safety</h3><ul class="small muted"><li>Email one is under 120 words, with a short lowercase subject, a research-based opening, and one clear call to action.</li><li>Follow-ups use distinct saved research details. The third email is a two-sentence close.</li><li>Each draft is scored from 0 to 100 and low scores trigger one revision attempt. Drafts below 70 cannot be scheduled.</li><li>Every email keeps its unsubscribe link. You can edit and rescore first. After explicit scheduling, Gmail sends within the local-time window and safety caps.</li></ul></div>`;
  const run = document.getElementById('run-copywriting');
  if (run) run.onclick = async () => { run.disabled = true; document.getElementById('copywriting-run-status').textContent = 'Generating and scoring…'; try { const result = await post('copywriting/run', {}); document.getElementById('copywriting-run-status').textContent = `${result.processed || 0} jobs processed`; route(); } catch (err) { document.getElementById('copywriting-run-status').textContent = err.message; run.disabled = false; } };
}

async function renderResearch() {
  const [data, peopleData] = await Promise.all([get('research'), get('people')]);
  const people = [...new Map(peopleData.people.map((p) => [Number(p.id), p])).values()];
  const notes = data.notes || [];
  appEl.innerHTML = `
  <div class="page-head"><div><h1>Research</h1><p class="sub">Store sourced company and prospect context. LinkedIn research is manual paste only; this foundation does not scrape LinkedIn or fetch the web.</p></div></div>
  <div class="panel"><h2 id="research-form-title">Add research note</h2>
    ${people.length ? `<form id="research-form">
      <input type="hidden" name="id" value="">
      <div class="f">
        <div><label>Prospect</label><select name="contact_id" required><option value="">Choose a prospect…</option>${people.map((p)=>`<option value="${p.id}">${esc(p.name || '(unnamed)')} · ${esc(p.title || 'no title')} · ${esc(p.company_name)}</option>`).join('')}</select></div>
        <div><label>Source type</label><select name="source_type"><option value="website">Company website</option><option value="news">News</option><option value="blog">Blog</option><option value="linkedin_manual">LinkedIn (manually supplied)</option><option value="podcast">Podcast</option></select></div>
      </div>
      <div class="f one"><div><label>Source URL (optional)</label><input name="source_url" type="url" maxlength="2048" placeholder="https://…"></div></div>
      <div class="f one"><div><label>Research summary</label><textarea name="summary" rows="4" maxlength="5000" placeholder="What did you verify from this source?"></textarea></div></div>
      <div class="f"><div><label>Pain points (one per line)</label><textarea name="pain_points" rows="3"></textarea></div><div><label>Potential talking points (one per line)</label><textarea name="talking_points" rows="3"></textarea></div></div>
      <div class="row"><button class="btn pri" id="research-save">Save research note</button><button class="btn" type="button" id="research-cancel" style="display:none">Cancel edit</button></div>
    </form>` : '<div class="empty">Add a contact first, then record sourced research here.</div>'}
  </div>
  <div class="panel"><h2>Saved research <span class="b plain">${notes.length}</span></h2>
    ${notes.length ? notes.map((n)=>{
      let pain=[],talk=[]; try {pain=JSON.parse(n.pain_points||'[]')}catch{} try{talk=JSON.parse(n.talking_points||'[]')}catch{}
      return `<article class="card pad mb" data-research="${n.id}"><div class="row" style="justify-content:space-between;align-items:flex-start"><div><b>${esc(n.contact_name || '(unnamed)')}</b> · ${esc(n.title || '')} <span class="muted">at ${esc(n.company_name || '')}</span><div class="sub2">${esc(n.source_type)} · ${esc(n.fetched_at || '')}${n.source_url ? ` · <a href="${esc(safeUrl(n.source_url))}" target="_blank" rel="noopener noreferrer">Open source</a>` : ''}</div></div><div class="row"><button class="btn xs" data-research-edit="${n.id}">Edit</button><button class="btn xs danger" data-research-delete="${n.id}">Delete</button></div></div><p>${esc(n.summary || 'No summary saved.')}</p>${pain.length?`<div><b>Pain points:</b> ${pain.map(esc).join(' · ')}</div>`:''}${talk.length?`<div class="mt"><b>Talking points:</b> ${talk.map(esc).join(' · ')}</div>`:''}</article>`;
    }).join('') : '<div class="empty">No research notes yet.</div>'}
  </div>`;
  const form = document.getElementById('research-form');
  if (!form) return;
  const editBtn = document.getElementById('research-save');
  const cancelBtn = document.getElementById('research-cancel');
  const lines = (value) => String(value || '').split(/\n|,/).map((x)=>x.trim()).filter(Boolean);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const values = formObject(form);
    const id = values.id;
    values.pain_points = lines(values.pain_points);
    values.talking_points = lines(values.talking_points);
    delete values.id;
    if (id) { delete values.contact_id; await put('research/' + id, values); toast('Research updated'); }
    else { await post('research', values); toast('Research note saved'); }
    route();
  };
  cancelBtn.onclick = () => route();
  document.querySelectorAll('[data-research-delete]').forEach((b)=>b.onclick=async()=>{
    if (!confirm('Delete this research note?')) return;
    await del('research/' + b.dataset.researchDelete); route();
  });
  document.querySelectorAll('[data-research-edit]').forEach((b)=>b.onclick=()=>{
    const n=notes.find((x)=>Number(x.id)===Number(b.dataset.researchEdit)); if(!n)return;
    form.elements.id.value=n.id;
    form.elements.contact_id.value=n.contact_id;
    form.elements.contact_id.disabled=true;
    form.elements.source_type.value=n.source_type;
    form.elements.source_url.value=n.source_url||'';
    form.elements.summary.value=n.summary||'';
    try{form.elements.pain_points.value=JSON.parse(n.pain_points||'[]').join('\n')}catch{form.elements.pain_points.value=''}
    try{form.elements.talking_points.value=JSON.parse(n.talking_points||'[]').join('\n')}catch{form.elements.talking_points.value=''}
    document.getElementById('research-form-title').textContent='Edit research note';
    editBtn.textContent='Save changes'; cancelBtn.style.display='';
    form.scrollIntoView({behavior:'smooth',block:'start'});
  });
}

/* =============================================================== INBOX */
async function renderInbox() {
  const data = await get('inbox');
  const replies = data.replies || [];
  const classifications = [['positive','Positive'],['neutral','Neutral'],['not_interested','Not interested / suppress'],['out_of_office','Out of office'],['unsubscribe','Unsubscribe / suppress'],['auto_reply','Auto reply']];
  const labels = Object.fromEntries(classifications);
  const badgeClass = (value) => value === 'positive' ? 'replied' : ['unsubscribe','not_interested'].includes(value) ? 'overdue' : value === 'out_of_office' ? 'paused' : value === 'auto_reply' ? 'slate' : 'active';
  appEl.innerHTML = `
  <div class="page-head"><div><h1>Inbox / Replies</h1><p class="sub">Review each conversation, edit suggested replies, and send them yourself. No reply is sent automatically. Non-OOO replies stop the remaining sequence.</p></div></div>
  <div class="row" style="justify-content:space-between;margin-bottom:12px"><h2>Incoming replies <span class="b plain">${replies.length}</span></h2><a class="btn" href="#/settings">Configure sender settings</a></div>
  ${replies.length ? replies.map((r) => {
    const thread = r.thread_messages || [{ direction:'in',subject:r.subject,body:r.reply_body || r.raw_text,sent_at:r.received_at }];
    return `<section class="panel" style="margin-bottom:14px">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px">
        <div><a href="#/contact/${r.prospect_id}"><b>${esc(r.prospect_name || '(unnamed)')}</b></a> <span class="sub2">${esc(r.email || '')}</span><div class="sub2">${esc(r.company_name || '')} · ${esc(r.received_at || '')}</div><div style="margin-top:7px"><b>${esc(r.subject || '(no subject)')}</b></div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="b ${badgeClass(r.classification)}">${esc(labels[r.classification] || r.classification || 'Neutral')}</span><select data-reply-class="${r.reply_id}" aria-label="Reply classification">${classifications.map(([v,l])=>`<option value="${v}"${r.classification===v?' selected':''}>${l}</option>`).join('')}</select></div>
      </div>
      <details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">View thread (${thread.length} message${thread.length===1?'':'s'})</summary><div style="margin-top:10px;display:grid;gap:10px">
        ${thread.map((m) => `<article style="border-left:3px solid ${m.direction==='out'?'var(--brand)':'var(--ok)'};padding:8px 12px;background:var(--surface-2);border-radius:0 8px 8px 0"><div class="row" style="justify-content:space-between"><b>${m.direction==='out'?'Origami sent':'Prospect replied'}</b><span class="sub2">${esc(m.sent_at || m.created_at || '')}</span></div><div class="sub2" style="margin-top:3px">${esc(m.subject || '')}</div><div style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:7px">${esc(m.body || '')}</div></article>`).join('')}
      </div></details>
      ${r.classification_error ? `<div class="sub2" style="color:var(--warn);margin-top:10px">Classification fallback: ${esc(r.classification_error)}. You can set the classification manually.</div>` : ''}
      ${r.classification === 'out_of_office' && r.return_date ? `<div class="sub2" style="margin-top:8px">Sequence paused; next step resumes after ${esc(r.return_date)}.</div>` : ''}
      <div style="margin-top:14px"><label for="reply-suggestion-${r.reply_id}">Suggested reply · edit before sending</label><textarea id="reply-suggestion-${r.reply_id}" data-reply-suggestion="${r.reply_id}" rows="4" maxlength="12000" placeholder="No suggestion available. Write or paste a reply here.">${esc(r.suggested_reply || '')}</textarea><div class="row" style="justify-content:space-between;margin-top:8px"><div class="sub2">Saved only in Inbox. Copy it to Gmail and send manually.</div><div class="row"><button class="btn sm" data-save-suggestion="${r.reply_id}">Save suggestion</button>${r.handled_at ? `<span class="b replied">Handled · ${esc(r.handled_at)}</span><button class="btn sm gh" data-mark-handled="${r.reply_id}" data-handled="false">Reopen</button>` : `<button class="btn sm ok" data-mark-handled="${r.reply_id}" data-handled="true">Mark handled</button>`}</div></div></div>
    </section>`;
  }).join('') : '<div class="panel empty">No replies recorded yet. Log one on a contact or connect Gmail to detect replies in sent threads.</div>'}`;
  document.querySelectorAll('[data-reply-class]').forEach((select) => select.onchange = async () => {
    const result = await put('replies/' + select.dataset.replyClass, { classification: select.value });
    toast(['unsubscribe','not_interested'].includes(result.classification) ? 'Permanent suppression recorded; sequence stopped' : 'Reply classification saved');
    route();
  });
  document.querySelectorAll('[data-save-suggestion]').forEach((button) => button.onclick = async () => {
    const id = button.dataset.saveSuggestion;
    const field = document.querySelector(`[data-reply-suggestion="${id}"]`);
    await put('replies/' + id, { suggested_reply: field?.value || '' });
    toast('Suggested reply saved. It has not been sent.');
  });
  document.querySelectorAll('[data-mark-handled]').forEach((button) => button.onclick = async () => {
    await put('replies/' + button.dataset.markHandled, { handled: button.dataset.handled === 'true' });
    toast(button.dataset.handled === 'true' ? 'Reply marked handled' : 'Reply reopened');
    route();
  });
}

/* ========================================================== OUTREACH PROJECTS */
async function renderProjects() {
  const { projects } = await get('projects');
  appEl.innerHTML = `
  <div class="page-head"><div><h1>Outreach projects</h1>
    <p class="sub">Build separate prospect lists for an outreach campaign. Rules can auto-match new spreadsheet imports by job title and location; manual additions and removals remain under your control.</p></div></div>
  <div class="panel"><h2>New project</h2>
    <form id="project-create" class="grid3">
      <div><label>Project / category name</label><input name="name" placeholder="Canada technology leaders" required maxlength="120"></div>
      <div><label>Job-title terms (comma-separated)</label><input name="title_terms" placeholder="CTO, VP Engineering"></div>
      <div><label>Location terms (comma-separated)</label><input name="location_terms" placeholder="Canada, Toronto"></div>
      <div><label>When both rules are set</label><select name="match_mode"><option value="all">Require both title and location</option><option value="any">Match either title or location</option></select></div>
      <div style="grid-column:span 2"><label>Project context / notes</label><input name="description" placeholder="Goal, offer, or notes for this outreach project"></div>
      <div class="row" style="grid-column:1/-1"><button class="btn pri">Create project</button><span class="small muted">Leave both match fields blank for a manual-only project. Rules use the person's title and the company's city, country, or HQ text.</span></div>
    </form>
  </div>
  ${projects.length ? `<div class="grid2">${projects.map((p) => `
    <div class="card pad">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
        <div><h2 style="margin:0"><a href="#/projects/${p.id}">${esc(p.name)}</a></h2>
          <p class="sub small" style="margin:6px 0">${esc(p.description || 'No project context added.')}</p>
        </div><a class="btn sm" href="#/projects/${p.id}">Open & manage</a>
      </div>
      <div class="chips mt"><span class="b active">${p.member_count} people</span><span class="b plain">${p.auto_count} auto</span><span class="b plain">${p.manual_count} manual</span></div>
      <div class="sub2 mt">Titles: ${esc(p.title_terms || 'manual only')} · Locations: ${esc(p.location_terms || 'any')}</div>
    </div>`).join('')}</div>` : '<div class="empty"><div class="big">🗂</div>No projects yet. Create a project above to group prospects for separate outreach.</div>'}`;
  document.getElementById('project-create').onsubmit = async (e) => {
    e.preventDefault();
    const result = await post('projects', formObject(e.target));
    toast(`Project created · ${result.auto_added} existing prospects matched`);
    location.hash = '#/projects/' + result.id;
  };
}

async function renderProject(id) {
  const [data, peopleData] = await Promise.all([get('projects/' + id), get('people')]);
  const project = data.project;
  const members = data.members;
  const memberIds = new Set(members.map((p) => Number(p.id)));
  const available = peopleData.people.filter((p) => !memberIds.has(Number(p.id)));
  appEl.innerHTML = `
  <div class="page-head"><div><p class="sub"><a href="#/projects">← All projects</a></p><h1>${esc(project.name)}</h1>
    <p class="sub">${esc(project.description || 'No context notes yet.')}</p></div><div class="sp"></div><button class="btn" id="project-sync">Recheck automatic matches</button></div>
  <div class="panel"><h2>Edit project and matching rules</h2>
    <form id="project-edit" class="grid3">
      <div><label>Project / category name</label><input name="name" value="${esc(project.name)}" required maxlength="120"></div>
      <div><label>Job-title terms (comma-separated)</label><input name="title_terms" value="${esc(project.title_terms || '')}" placeholder="CTO, VP Engineering"></div>
      <div><label>Location terms (comma-separated)</label><input name="location_terms" value="${esc(project.location_terms || '')}" placeholder="Canada, Toronto"></div>
      <div><label>When both rules are set</label><select name="match_mode"><option value="all"${project.match_mode !== 'any' ? ' selected' : ''}>Require both title and location</option><option value="any"${project.match_mode === 'any' ? ' selected' : ''}>Match either title or location</option></select></div>
      <div style="grid-column:span 2"><label>Project context / notes</label><input name="description" value="${esc(project.description || '')}" placeholder="Goal, offer, or notes for this outreach project"></div>
      <div class="row" style="grid-column:1/-1"><button class="btn pri">Save rules and context</button><button type="button" class="btn danger" id="project-delete">Delete project</button><span class="small muted">Deleting this project removes only its grouping. It does not delete any contact or company records.</span></div>
    </form>
  </div>
  <div class="panel"><div class="row" style="justify-content:space-between"><div><h2>Project members <span class="b plain">${members.length}</span></h2><p class="sub small">Remove only removes someone from this project. Their CRM contact remains unchanged.</p></div></div>
    ${members.length ? `<div class="tbl-scroll"><table><thead><tr><th>Person</th><th>Job title</th><th>Company</th><th>Location</th><th>Added by</th><th></th></tr></thead><tbody>
      ${members.map((p) => `<tr><td><a href="#/contact/${p.id}"><b>${esc(p.name || '(unnamed)')}</b></a></td><td>${esc(p.title || '—')}</td><td><a href="#/companies/${p.company_id}">${esc(p.company_name)}</a></td><td>${esc([p.city,p.country,p.hq].filter(Boolean).join(', ') || '—')}</td><td><span class="b ${p.source === 'manual' ? 'replied' : 'plain'}">${p.source === 'manual' ? 'Manual' : 'Auto match'}</span></td><td><button class="btn xs danger" data-project-remove="${p.id}">Remove</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No prospects in this project yet.</div>'}
  </div>
  <div class="panel"><h2>Add prospects manually</h2><p class="sub small">Select any contacts to include, even when they do not match the title/location rules. Manual choices are preserved when rules are refreshed.</p>
    ${available.length ? `<input id="project-search" type="search" placeholder="Find by person, title, company, or location…" style="max-width:520px;margin-bottom:10px"><div id="project-available"></div><button id="project-add" class="btn pri mt" disabled>Add selected to this project</button>` : '<div class="empty">All CRM contacts are already in this project.</div>'}
  </div>`;
  document.getElementById('project-edit').onsubmit = async (e) => {
    e.preventDefault();
    const r = await put('projects/' + project.id, formObject(e.target));
    toast(`Project saved · ${r.auto_added} added, ${r.auto_removed} automatic matches removed`);
    route();
  };
  document.getElementById('project-sync').onclick = async () => {
    const r = await post('projects/' + project.id + '/sync', {});
    toast(`Matches refreshed · ${r.added} added, ${r.removed} removed`);
    route();
  };
  document.getElementById('project-delete').onclick = async () => {
    if (!confirm('Delete this project and its membership list? Contacts and companies will not be deleted.')) return;
    await del('projects/' + project.id);
    location.hash = '#/projects';
  };
  document.querySelectorAll('[data-project-remove]').forEach((button) => button.onclick = async () => {
    await post('projects/' + project.id + '/members', { action: 'remove', contact_ids: [+button.dataset.projectRemove] });
    toast('Removed from this project; CRM contact kept');
    route();
  });
  const availableRoot = document.getElementById('project-available');
  if (availableRoot) {
    const selected = new Set();
    const search = document.getElementById('project-search');
    const addButton = document.getElementById('project-add');
    const drawAvailable = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = available.filter((p) => !query || [p.name,p.title,p.company_name,p.market_label,p.hq].some((v) => String(v || '').toLocaleLowerCase().includes(query))).slice(0, 100);
      availableRoot.innerHTML = matches.length ? `<div class="tbl-scroll"><table><thead><tr><th></th><th>Person</th><th>Job title</th><th>Company</th><th>Location</th></tr></thead><tbody>${matches.map((p) => `<tr><td><input type="checkbox" data-project-pick="${p.id}"${selected.has(Number(p.id)) ? ' checked' : ''}></td><td>${esc(p.name || '(unnamed)')}</td><td>${esc(p.title || '—')}</td><td>${esc(p.company_name)}</td><td>${esc([p.city,p.country,p.hq].filter(Boolean).join(', ') || '—')}</td></tr>`).join('')}</tbody></table></div>${available.length > 100 ? `<div class="small muted">Showing up to 100 matches. Refine your search to find others.</div>` : ''}` : '<div class="small muted">No unassigned people match this search.</div>';
      availableRoot.querySelectorAll('[data-project-pick]').forEach((input) => input.onchange = () => {
        const contactId = Number(input.dataset.projectPick);
        if (input.checked) selected.add(contactId); else selected.delete(contactId);
        addButton.disabled = selected.size === 0;
        addButton.textContent = selected.size ? `Add ${selected.size} selected to this project` : 'Add selected to this project';
      });
    };
    search.oninput = drawAvailable;
    drawAvailable();
    addButton.onclick = async () => {
      if (!selected.size) return;
      await post('projects/' + project.id + '/members', { action: 'add', contact_ids: [...selected] });
      toast(`Added ${selected.size} prospects manually`);
      route();
    };
  }
}

/* ======================================================== SEQUENCE HEALTH */
async function renderSequenceHealth() {
  const data = await get('sequence-health');
  const rows = data.sequences || [];
  const domains = data.domain_suppressions || [];
  appEl.innerHTML = `<div class="page-head"><div><h1>Sequence Health</h1><p class="sub">Every active, paused, and completed sequence, with the reason any follow-up stopped.</p></div><div class="sp"></div><a class="btn" href="#/sequences">Sequence Builder</a></div>
    <div class="chips mb"><button class="btn sm" data-health-filter="active">Active · ${data.counts?.active||0}</button><button class="btn sm" data-health-filter="paused">Paused · ${data.counts?.paused||0}</button><button class="btn sm" data-health-filter="completed">Completed · ${data.counts?.completed||0}</button><button class="btn sm" data-health-filter="all">All · ${rows.length}</button></div>
    ${domains.length ? `<div class="panel"><h3>Suppressed recipient domains</h3><p class="small muted">Domains with at least two recorded Gmail bounces are excluded from future automated sends.</p><div class="chips">${domains.map(d=>`<span class="b due">${esc(d.domain)} · ${d.bounce_count} bounces</span>`).join('')}</div></div>` : ''}
    <div class="card pad-sm"><div class="scroll"><table><thead><tr><th>Status</th><th>Prospect</th><th>Sequence</th><th>Step</th><th>Next scheduled send</th><th>Why paused</th></tr></thead><tbody id="sequence-health-rows">${rows.length ? rows.map((r)=>`<tr data-health-status="${esc(r.status)}"><td><span class="b ${r.status==='active'?'active':r.status==='completed'?'replied':'due'}">${esc(r.status)}</span></td><td><a href="#/contact/${r.contact_id}">${esc(r.contact_name)}</a><div class="sub2">${esc(r.company_name||'')} · ${esc(r.email||'')}</div></td><td>${esc(r.sequence_name||'Default Gmail cadence')}<div class="sub2">${esc(r.source||'')}</div></td><td>${r.status==='completed'?4:Math.min(4,Number(r.step_index||0)+1)} of 4</td><td>${esc(r.next_step_at||'—')}</td><td>${r.status==='paused'?esc(r.pause_reason||'Paused by user'):'—'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No sequences to display yet.</td></tr>'}</tbody></table></div></div>`;
  document.querySelectorAll('[data-health-filter]').forEach((button)=>button.onclick=()=>{ const filter=button.dataset.healthFilter; document.querySelectorAll('#sequence-health-rows tr[data-health-status]').forEach((row)=>{ row.style.display=filter==='all'||row.dataset.healthStatus===filter?'':'none'; }); });
}

/* ============================================================== SEQUENCES */
async function renderSequences() {
  const [d, people] = await Promise.all([get('sequences'), get('people')]);
  const seqs = d.sequences;
  appEl.innerHTML = `
  <div class="page-head">
    <div><h1>Sequence Builder</h1>
      <p class="sub">A defined journey instead of one repeated cadence. Each step has its own wait,
      channel and message — and the sequence stops the moment someone replies.</p></div>
    <div class="sp"></div>
    <a class="btn" href="#/sequence-health">Sequence Health</a>
    <button class="btn pri" id="newseq">New sequence</button>
  </div>

  ${seqs.length ? seqs.map((s) => `
    <div class="card mb" data-seq="${s.id}">
      <div class="pad" style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <h2>${esc(s.name)} ${s.active ? '' : '<span class="b plain">paused</span>'}</h2>
          <p class="sub small" style="margin:2px 0 0">${esc(s.description || '')}</p>
          <div class="chips mt">
            <span class="b ${s.enrolled ? 'active' : 'plain'}">${s.enrolled} enrolled</span>
            <span class="b plain">${s.steps.length} steps</span>
            <span class="b plain">${s.steps.reduce((n, x) => n + (x.wait_days || 0), 0)} days total</span>
          </div>
        </div>
        <div class="row tight">
          <button class="btn sm" data-enrol="${s.id}">Enrol people</button>
          <button class="btn sm" data-toggle="${s.id}">${s.active ? 'Pause' : 'Activate'}</button>
          <button class="btn sm danger" data-del="${s.id}">Delete</button>
        </div>
      </div>
      <div class="tbl-scroll" style="border-top:1px solid var(--line)"><table>
        <thead><tr><th style="width:44px">#</th><th>Channel</th><th>Message</th><th>Wait</th><th>Condition</th><th></th></tr></thead>
        <tbody>
        ${s.steps.map((st, i) => `
          <tr>
            <td class="mono">${i + 1}</td>
            <td><span class="b ${st.channel === 'email' ? 'active' : 'new'}">${esc(st.channel)}</span></td>
            <td><b>${esc(st.subject || '(no subject)')}</b><div class="sub2">${esc((st.body || '').slice(0, 90))}${(st.body || '').length > 90 ? '…' : ''}</div></td>
            <td class="mono">${i===0 ? 'Day 0' : `+${st.wait_days} business days`}</td>
            <td class="small muted">${esc(st.condition || 'always')}</td>
            <td class="rowact"><button class="btn xs" data-editstep="${st.id}">Edit</button></td>
          </tr>`).join('')}
        ${s.steps.length ? '' : '<tr><td colspan="6" class="empty">No steps yet.</td></tr>'}
        </tbody></table></div>
      <div class="pad-sm"><button class="btn sm" data-addstep="${s.id}">+ Add step</button></div>
    </div>`).join('')
    : '<div class="card empty"><div class="big">🔁</div>No sequences yet. Create one to give your outreach a proper shape.</div>'}`;

  document.getElementById('newseq').onclick = async () => {
    const name = prompt('Sequence name?', 'Marketplace founders — 4 touches');
    if (!name) return;
    const r = await post('sequences', { name, description: '' });
    // seed 4 sensible steps
    const base = [
      { channel: 'email', subject: '{{first_name}} — {{company}}', body: 'Hi {{first_name}},\n\n', wait_days: 0 },
      { channel: 'email', subject: 'Re: {{company}}', body: 'Hi {{first_name}},\n\nI wanted to follow up on my note about {{company}}.\n\n', wait_days: 3 },
      { channel: 'email', subject: 'Re: {{company}}', body: 'Bumping this…', wait_days: 4 },
      { channel: 'email', subject: 'Last one from me', body: 'Hi {{first_name}},\n\nI will leave it here after this note.\n\n', wait_days: 5 },
    ];
    for (const st of base) await post('sequences/' + r.id + '/steps', st);
    toast('Sequence created'); route();
  };
  qsa('[data-addstep]').forEach((b) => b.onclick = () => editStep(+b.dataset.addstep, null));
  qsa('[data-editstep]').forEach((b) => b.onclick = async () => {
    const all = seqs.reduce((a, s) => a.concat(s.steps), []);
    editStep(null, all.find((x) => x.id === +b.dataset.editstep));
  });
  qsa('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this sequence and its enrolments?')) return;
    await del('sequences/' + b.dataset.del); route();
  });
  qsa('[data-toggle]').forEach((b) => b.onclick = async () => {
    const s = seqs.find((x) => x.id === +b.dataset.toggle);
    await put('sequences/' + s.id, { active: !s.active });
    route();
  });
  qsa('[data-enrol]').forEach((b) => b.onclick = () => enrolModal(+b.dataset.enrol, people.people));

  function editStep(seqId, step) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="palette-wrap" id="st-wrap"><div class="palette" style="width:min(560px,94vw)">
      <div style="padding:16px">
        <h2 style="margin-bottom:10px">${step ? 'Edit step' : 'Add step'}</h2>
        <div class="f">
          <div><label>Channel</label><select id="st-ch">${CHANNELS.map((c) => `<option value="${c}"${step && step.channel === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
          <div><label>Wait before this step (business days)</label><input id="st-wait" type="number" min="0" max="30" value="${step ? step.wait_days : 3}"></div>
          <div><label>Condition</label><select id="st-cond">
            <option value="always"${step && step.condition === 'always' ? ' selected' : ''}>Always send</option>
            <option value="if_no_reply"${step && step.condition === 'if_no_reply' ? ' selected' : ''}>Only if no reply yet</option>
          </select></div>
        </div>
        <div class="f one"><div><label>Subject</label><input id="st-subj" value="${esc(step ? step.subject || '' : '')}" placeholder="{{first_name}} — {{company}}"></div></div>
        <div class="f one"><div><label>Message</label><textarea id="st-body" style="min-height:150px" placeholder="Merge fields: {{first_name}}, {{company}}, {{sub_niche}}, {{what_they_do}}, {{hq}}, {{funding}}">${esc(step ? step.body || '' : '')}</textarea></div></div>
        <div class="row"><div class="sp"></div>
          <button class="btn" id="st-cancel">Cancel</button>
          <button class="btn pri" id="st-save">Save step</button></div>
      </div></div></div>`;
    const close = () => { root.innerHTML = ''; };
    document.getElementById('st-cancel').onclick = close;
    root.querySelector('#st-wrap').onclick = (e) => { if (e.target.id === 'st-wrap') close(); };
    document.getElementById('st-save').onclick = async () => {
      const payload = { channel: document.getElementById('st-ch').value, wait_days: +document.getElementById('st-wait').value,
                        condition: document.getElementById('st-cond').value,
                        subject: document.getElementById('st-subj').value, body: document.getElementById('st-body').value };
      if (step) await put('steps/' + step.id, payload);
      else await post('sequences/' + seqId + '/steps', payload);
      close(); toast('Step saved'); route();
    };
  }
  function enrolModal(seqId, list) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="palette-wrap" id="en-wrap"><div class="palette" style="width:min(560px,94vw)">
      <div style="padding:16px">
        <h2 style="margin-bottom:4px">Enrol people</h2>
        <p class="sub small">They start at step 1 on day 0. For automatic Gmail, select this sequence when scheduling reviewed drafts. Anyone already in another sequence is moved.</p>
        <input id="en-q" placeholder="Filter by name or company…" style="margin-bottom:8px">
        <div style="max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px">
          <table><tbody id="en-rows">
          ${list.slice(0, 300).map((p) => `<tr data-n="${esc((p.name + ' ' + p.company_name).toLowerCase())}">
            <td style="width:30px"><input type="checkbox" class="cb en-cb" value="${p.id}"></td>
            <td><b>${esc(p.name)}</b><div class="sub2">${esc(p.company_name)}</div></td>
            <td class="small muted">${esc(p.status)}</td></tr>`).join('')}
          </tbody></table></div>
        <div class="row mt"><div class="sp"></div>
          <button class="btn" id="en-cancel">Cancel</button>
          <button class="btn pri" id="en-save">Enrol selected</button></div>
      </div></div></div>`;
    const close = () => { root.innerHTML = ''; };
    document.getElementById('en-cancel').onclick = close;
    root.querySelector('#en-wrap').onclick = (e) => { if (e.target.id === 'en-wrap') close(); };
    document.getElementById('en-q').oninput = (e) => {
      const v = e.target.value.toLowerCase();
      root.querySelectorAll('#en-rows tr').forEach((tr) => {
        tr.style.display = tr.dataset.n.includes(v) ? '' : 'none';
      });
    };
    document.getElementById('en-save').onclick = async () => {
      const ids = Array.from(root.querySelectorAll('.en-cb:checked')).map((c) => +c.value);
      if (!ids.length) { close(); return; }
      const r = await post('sequences/' + seqId + '/enroll', { contact_ids: ids });
      close(); toast('Enrolled ' + r.enrolled + ' people'); route(); refreshCounts();
    };
  }
}
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

/* ================================================================== TASKS */
async function renderTasks() {
  const d = await get('tasks');
  const open = d.tasks.filter((t) => !t.done);
  const done = d.tasks.filter((t) => t.done);
  const todayStr = new Date().toISOString().slice(0, 10);
  appEl.innerHTML = `
  <div class="page-head">
    <div><h1>Tasks</h1><p class="sub">Manual to-dos, separate from the automatic follow-up engine.</p></div>
  </div>
  <div class="grid2">
    <div>
      <div class="card pad mb">
        <h3>Add a task</h3>
        <form id="taskform">
          <div class="f one"><div><label>What needs doing</label><input name="title" required placeholder="Comment on their LinkedIn post"></div></div>
          <div class="f">
            <div><label>Due date</label><input type="date" name="due_date" value="${todayStr}"></div>
            <div><label>Link to person (optional)</label><select name="contact_id">
              <option value="">— none —</option>
              ${(await get('people')).people.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.company_name)}</option>`).join('')}
            </select></div>
          </div>
          <button class="btn pri">Add task</button>
        </form>
      </div>
      <div class="card">
        <div class="pad-sm" style="border-bottom:1px solid var(--line)"><h3 style="margin:0">Open (${open.length})</h3></div>
        ${open.length ? open.map((t) => taskRow(t, todayStr)).join('')
          : '<div class="empty"><div class="big">✅</div>Nothing outstanding.</div>'}
      </div>
    </div>
    <div>
      <div class="card">
        <div class="pad-sm" style="border-bottom:1px solid var(--line)"><h3 style="margin:0">Done (${done.length})</h3></div>
        ${done.length ? done.slice(0, 30).map((t) => taskRow(t, todayStr)).join('')
          : '<div class="empty small">Nothing completed yet.</div>'}
      </div>
    </div>
  </div>`;
  document.getElementById('taskform').onsubmit = async (e) => {
    e.preventDefault();
    const o = formObject(e.target);
    await post('tasks', { title: o.title, due_date: o.due_date, contact_id: o.contact_id || null });
    toast('Task added'); route(); refreshCounts();
  };
  qsa('.task-done').forEach((c) => c.onchange = async () => {
    await put('tasks/' + c.dataset.id, { done: c.checked ? 1 : 0 });
    route(); refreshCounts();
  });
  qsa('.task-del').forEach((b) => b.onclick = async () => { await del('tasks/' + b.dataset.id); route(); refreshCounts(); });
}
function taskRow(t, todayStr) {
  const late = t.due_date && !t.done && t.due_date < todayStr;
  return `<div class="pad-sm" style="border-bottom:1px solid #F0F1F4;display:flex;gap:9px;align-items:flex-start">
    <input type="checkbox" class="cb task-done" data-id="${t.id}" ${t.done ? 'checked' : ''} style="margin-top:3px">
    <div style="flex:1;min-width:0">
      <div style="${t.done ? 'text-decoration:line-through;color:var(--faint)' : 'font-weight:550'}">${esc(t.title)}</div>
      <div class="sub2">
        ${t.due_date ? `<span class="mono ${late ? '' : 'muted'}" style="${late ? 'color:var(--bad);font-weight:600' : ''}">${esc(t.due_date)}${late ? ' · overdue' : ''}</span>` : 'no date'}
        ${t.contact_name ? ` · <a href="#/contact/${t.contact_id}">${esc(t.contact_name)}</a>` : ''}
        ${t.company_name ? ` · ${esc(t.company_name)}` : ''}
      </div>
    </div>
    <button class="iconbtn task-del" data-id="${t.id}" title="Delete">✕</button>
  </div>`;
}

/* ============================================================== ANALYTICS */
async function renderAnalytics() {
  const ins = await get('insights');
  const t = ins.totals;
  appEl.innerHTML = `
  <div class="page-head">
    <div><h1>Analytics</h1><p class="sub">Reply rate is the number that matters. Opens are not tracked — Apple's
      Mail Privacy Protection makes them fiction.</p></div>
  </div>
  <div class="stats">
    ${stat(t.contacted, 'People contacted')}
    ${stat(t.sent, 'Messages sent')}
    ${stat(t.replied, 'Replied', 'green')}
    ${stat(t.rate + '%', 'Reply rate', t.rate >= 8 ? 'green' : t.rate >= 3 ? 'amber' : 'red')}
    ${stat(t.meetings, 'Meetings')}
    ${stat(t.won, 'Won', 'green')}
    ${stat(t.overdue, 'Overdue', 'red')}
    ${stat(t.neverTouched, 'Never touched')}
  </div>

  <div class="grid3">
    <div class="card pad"><h3>By channel</h3>
      ${barList(ins.byChannel)}</div>
    <div class="card pad"><h3>By touch number</h3>
      ${barList(ins.byTouch)}</div>
    <div class="card pad"><h3>By day sent</h3>
      ${barList(ins.byWeekday)}</div>
  </div>

  ${ins.byTemplate.length ? `<div class="card pad mt"><h3>By template</h3>${barList(ins.byTemplate)}</div>` : ''}

  <div class="card pad mt">
    <h3>Recommendations</h3>
    ${ins.recommendations.map((r) => `
      <div style="padding:9px 0;border-bottom:1px solid #F0F1F4">
        <span class="b ${r.level === 'good' ? 'replied' : r.level === 'warn' ? 'due' : 'new'}">${esc(r.level)}</span>
        <b style="margin-left:7px">${esc(r.title)}</b>
        <div class="muted small" style="margin-top:3px">${esc(r.detail)}</div>
      </div>`).join('')}
  </div>

  <div class="card pad mt">
    <h3>Benchmarks to aim at</h3>
    <table><thead><tr><th>Metric</th><th>Warning</th><th>Good</th><th>Top decile</th></tr></thead><tbody>
      <tr><td>Reply rate (B2B cold)</td><td class="muted">&lt;3%</td><td>5–8%</td><td>8–15%</td></tr>
      <tr><td>Subject line length</td><td class="muted">&gt;50 chars</td><td>30–45</td><td>21–40, lowercase</td></tr>
      <tr><td>Daily sends per mailbox</td><td class="muted">&gt;50</td><td>30–50</td><td>15–20</td></tr>
      <tr><td>Bounce rate</td><td class="muted">&gt;2%</td><td>&lt;2%</td><td>&lt;0.5%</td></tr>
    </tbody></table>
    <p class="small faint mt">2026 cold-email benchmarks — see RESEARCH.md for sources.</p>
  </div>`;
}
function barList(rows) {
  if (!rows || !rows.length) return '<div class="empty small">No data yet.</div>';
  const max = Math.max.apply(null, rows.map((r) => r.sent || 0).concat([1]));
  return rows.map((r) => `
    <div style="margin-bottom:10px">
      <div class="row" style="justify-content:space-between;font-size:12.5px;margin-bottom:3px">
        <span>${esc(r.name)}</span>
        <span class="mono muted">${r.replies}/${r.sent} · ${r.rate}%</span>
      </div>
      <div class="bar"><i class="${r.rate >= 8 ? 'ok' : r.rate >= 3 ? 'warn' : ''}" style="width:${Math.round((r.sent / max) * 100)}%"></i></div>
    </div>`).join('');
}

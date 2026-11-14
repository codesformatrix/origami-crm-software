// Smart scheduling engine: IANA timezones (DST-correct), prospect-local weekends,
// public holidays, and send-window reasoning. No naive date arithmetic.

import {
  CITY_TZ, REGION_TZ, COUNTRY_TZ, COUNTRY_ALIASES, WEEKEND, HOLIDAYS, SEND_WINDOWS, COUNTRY_CODE,
} from './tzdata.js';

/* ------------------------------------------------------------- normalising */
export function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

const LEAD = [
  /^crunchbase lists?\s+/, /^tracxn lists?\s+/, /^tracker lists?\s+/, /^yc lists?\s+/,
  /^y combinator lists?\s+/, /^also listed as\s+/, /^founded in\s+/, /^based in\s+/,
  /^per\s+/, /^cb insights lists?\s+/, /^preqin lists?\s+/, /^companycheck lists?\s+/,
  /^with\s+/, /^and\s+/, /^the\s+/, /^remote\s+/,
];
const TAIL = [
  /\s+city$/, /\s+area$/, /\s+metro$/, /\s+greater$/, /\s+county$/, /\s+presence$/,
  /\s+operations$/, /\s+province$/, /\s+region$/,
];

function cleanToken(t) {
  let x = norm(t);
  // "companycheck and Crunchbase list New York" -> "new york"
  x = x.replace(/^.*\blists?\s+(?=[a-z])/, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEAD) if (re.test(x)) { x = x.replace(re, ''); changed = true; }
    for (const re of TAIL) if (re.test(x)) { x = x.replace(re, ''); changed = true; }
  }
  return x.trim();
}

function titleCase(s) {
  return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

function findCountry(tokens, all) {
  // A short code can be ambiguous: "CA" is California in "Los Angeles, CA, USA"
  // but Canada in "Toronto, CA". Prefer a real country name, then a code that is
  // not also a state/province abbreviation, then anything else.
  const cand = [];
  for (const t of tokens) {
    if (COUNTRY_TZ[t]) cand.push({ key: t, kind: 3 });
    else if (COUNTRY_ALIASES[t] && COUNTRY_TZ[COUNTRY_ALIASES[t]]) {
      cand.push({ key: COUNTRY_ALIASES[t], kind: REGION_TZ[t] ? 1 : 2 });
    }
  }
  if (cand.length) {
    cand.sort((a, b) => b.kind - a.kind);
    return cand[0].key;
  }
  // last resort: a country name appearing anywhere in the string
  const keys = Object.keys(COUNTRY_TZ).sort((a, b) => b.length - a.length);
  for (const k of keys) if (k.length > 4 && all.includes(k)) return k;
  return '';
}

/**
 * Turn a free-text HQ string into a timezone + country.
 * Confidence: city > region (US state etc) > country > none.
 */
export function detectLocation(hq) {
  const raw = String(hq || '');
  const blank = { city: '', country: '', countryKey: '', countryCode: '', timezone: '', weekend: [0, 6], confidence: 'none' };
  if (!raw.trim()) return blank;

  const text = raw.replace(/[()[\]]/g, ',');
  const tokens = text.split(/[,;]|\s+-\s+/).map(cleanToken).filter(Boolean);
  const all = norm(text);
  const countryKey = findCountry(tokens, all);

  let city = '', timezone = '', confidence = 'none';
  for (const t of tokens) {
    let hit = CITY_TZ[t];
    if (!hit) hit = CITY_TZ[t.replace(/\s+city$/, '')];
    if (hit) { city = t; timezone = hit; confidence = 'city'; break; }
  }
  if (!timezone) {
    for (const t of tokens) {
      if (REGION_TZ[t]) { city = t; timezone = REGION_TZ[t]; confidence = 'region'; break; }
    }
  }
  if (!timezone && countryKey) { timezone = COUNTRY_TZ[countryKey]; confidence = 'country'; }

  return {
    city: titleCase(city),
    country: titleCase(countryKey),
    countryKey: countryKey || '',
    countryCode: (countryKey && COUNTRY_CODE[countryKey]) || '',
    timezone: timezone || '',
    weekend: (countryKey && WEEKEND[countryKey]) || [0, 6],
    confidence,
  };
}

/* -------------------------------------------------------------- date math */
export function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
}

export function dowOf(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  return d.getUTCDay(); // 0=Sun .. 6=Sat
}

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function partsIn(tz, when) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const x of dtf.formatToParts(when)) p[x.type] = x.value;
  return p;
}

/** Current wall-clock time in a timezone. */
export function nowIn(tz, when) {
  const now = when || new Date();
  const p = partsIn(tz, now);
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
  const mm = String(hour).padStart(2, '0') + ':' + p.minute;
  const dow = DOW_MAP[p.weekday];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour, minute: parseInt(p.minute, 10),
    time: mm, dow, weekday: DOW_NAME[dow],
  };
}

/** Minutes that a zone is ahead of UTC at a given instant (DST-aware). */
export function tzOffsetMinutes(tz, when) {
  const p = partsIn(tz, when);
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, 0);
  return Math.round((asUTC - when.getTime()) / 60000);
}

/** The UTC instant for a given wall-clock date/time in a zone. */
export function zonedToUtc(dateStr, hour, minute, tz) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute || 0, 0);
  let off = tzOffsetMinutes(tz, new Date(wall));
  let ts = wall - off * 60000;
  off = tzOffsetMinutes(tz, new Date(ts));
  return new Date(wall - off * 60000);
}

/* ------------------------------------------------- working days & holidays */
export function isWeekendDay(dateStr, countryKey) {
  const wk = (countryKey && WEEKEND[countryKey]) || [0, 6];
  return wk.indexOf(dowOf(dateStr)) >= 0;
}
export function isHoliday(dateStr, countryCode) {
  const list = countryCode && HOLIDAYS[countryCode];
  return !!(list && list.indexOf(String(dateStr).slice(0, 10)) >= 0);
}
export function isWorkingDay(dateStr, ctx) {
  const d = String(dateStr).slice(0, 10);
  return !isWeekendDay(d, ctx && ctx.countryKey) && !isHoliday(d, ctx && ctx.countryCode);
}
/** Roll a date forward to the next non-weekend, non-holiday day (max 3 weeks). */
export function nextWorkingDay(dateStr, ctx) {
  let d = String(dateStr).slice(0, 10);
  for (let i = 0; i < 21; i++) {
    if (isWorkingDay(d, ctx)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/**
 * The follow-up date: cadence counted in calendar days, then rolled forward
 * onto the prospect's next working day. Falls back to plain arithmetic only
 * when the company has no timezone at all.
 */
export function followUpDate(fromStr, cadenceDays, ctx) {
  const base = String(fromStr || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const raw = addDays(base, Number(cadenceDays) || 4);
  if (!ctx || !ctx.timezone) return raw;
  return nextWorkingDay(raw, ctx);
}

/** Gap widens as touches go unanswered: 4, 5, 7, 10... */
export function smartCadence(touchCount, base) {
  const b = Number(base) || 4;
  const t = Number(touchCount) || 0;
  if (t <= 1) return b;
  if (t === 2) return b + 1;
  if (t === 3) return b + 3;
  return b + 6;
}

/* ------------------------------------------------------------ send windows */
function windowsFor(dow) { return SEND_WINDOWS[String(dow)] || []; }

/**
 * Is now a good moment to contact this prospect?
 * Returns the local time, whether we're inside a window, and when the next one opens.
 */
export function windowStatus(tz, ctx, when) {
  const now = when || new Date();
  const countryCode = (ctx && ctx.countryCode) || '';
  if (!tz) return { ok: true, reason: 'unknown-timezone', local: null, minutesUntil: 0 };

  const local = nowIn(tz, now);
  if (isHoliday(local.date, countryCode)) {
    const nd = nextWorkingDay(addDays(local.date, 1), ctx);
    return { ok: false, reason: 'holiday', local, nextDate: nd, minutesUntil: minutesUntil(nd, 9, tz, now) };
  }
  const wins = windowsFor(local.dow);
  if (!wins.length) {
    const nd = nextWorkingDay(addDays(local.date, 1), ctx);
    return { ok: false, reason: 'weekend', local, nextDate: nd, minutesUntil: minutesUntil(nd, winsForNext(nd), tz, now) };
  }
  const t = local.hour + local.minute / 60;
  for (const w of wins) {
    if (t >= w.s && t < w.e) return { ok: true, reason: 'in-window', local, window: w, minutesUntil: 0 };
  }
  // before today's first window, or past the last one
  let nextDate = local.date, nextStart = null;
  for (const w of wins) if (t < w.s) { nextStart = w.s; break; }
  if (nextStart === null) {
    nextDate = nextWorkingDay(addDays(local.date, 1), ctx);
    nextStart = winsForNext(nextDate);
  }
  return {
    ok: false, reason: nextDate === local.date ? 'before-window' : 'after-window',
    local, nextDate, nextStart,
    minutesUntil: minutesUntil(nextDate, nextStart, tz, now),
  };
}

function winsForNext(dateStr) {
  const w = windowsFor(dowOf(dateStr));
  return w.length ? w[0].s : 9;
}

export function minutesUntil(dateStr, hour, tz, when) {
  const now = when || new Date();
  const target = zonedToUtc(dateStr, hour, 0, tz);
  return Math.max(0, Math.round((target.getTime() - now.getTime()) / 60000));
}

/** Human string: "in 3h 20m", "tomorrow at 09:00", "Mon 09:00". */
export function minutesToText(mins) {
  if (!mins || mins < 1) return 'now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 1440) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return `in ${h}h${m ? ' ' + m + 'm' : ''}`;
  }
  const d = Math.round(mins / 1440);
  return d === 1 ? 'tomorrow' : `in ${d} days`;
}

/** Short label for a timezone, e.g. "Europe/Berlin" -> "Berlin". */
export function tzLabel(tz) {
  if (!tz) return '';
  const tail = tz.split('/').pop().replace(/_/g, ' ');
  return tail;
}

/** Abbreviation + offset, e.g. "CET+1". */
export function tzShort(tz, when) {
  if (!tz) return '';
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(when || new Date());
    const v = (p.find((x) => x.type === 'timeZoneName') || {}).value || '';
    const off = tzOffsetMinutes(tz, when || new Date()) / 60;
    const sign = off >= 0 ? '+' : '';
    return `${v}${v.includes(String(Math.abs(off))) ? '' : sign + (off % 1 ? off.toFixed(1) : off)}`;
  } catch { return tzLabel(tz); }
}

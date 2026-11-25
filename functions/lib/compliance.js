const enc = new TextEncoder();

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function hashEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function isEmailSuppressed(DB, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const hash = await hashEmail(normalized);
  const hashed = await DB.prepare('SELECT email_hash FROM suppressed_email_hashes WHERE email_hash=?').bind(hash).first();
  if (hashed) return true;
  const legacy = await DB.prepare('SELECT email FROM suppressed_emails WHERE email=lower(trim(?))').bind(normalized).first();
  if (!legacy) return false;
  // Migrate the legacy clear-text suppression to a digest, then discard the plaintext address.
  await rememberSuppression(DB, normalized, 'legacy_suppression', 'migration');
  await DB.prepare('DELETE FROM suppressed_emails WHERE email=lower(trim(?))').bind(normalized).run();
  return true;
}

export async function rememberSuppression(DB, email, reason = 'unsubscribe', source = '', at = new Date().toISOString()) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const hash = await hashEmail(normalized);
  await DB.prepare('INSERT OR IGNORE INTO suppressed_email_hashes(email_hash,reason,source,created_at) VALUES(?,?,?,?)')
    .bind(hash, String(reason || 'unsubscribe').slice(0, 80), String(source || '').slice(0, 160), at).run();
}

export async function anonymizeSuppression(DB, email) {
  const hash = await hashEmail(email);
  if (!hash) return;
  // Preserve the original opt-out timestamp while dropping any prospect-linked source metadata.
  await DB.prepare("UPDATE suppressed_email_hashes SET reason='permanent_optout',source='erasure_preservation' WHERE email_hash=?")
    .bind(hash).run();
}

export function warmupCap(startDate, configuredCap, now = new Date()) {
  const configured = Math.max(0, Math.min(500, Number.isFinite(Number(configuredCap)) ? Math.floor(Number(configuredCap)) : 25));
  const today = now.toISOString().slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) ? String(startDate) : '';
  const start = parsed && parsed <= today ? parsed : today;
  const days = Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000));
  const week = Math.floor(days / 7) + 1;
  const ramp = week === 1 ? 5 : week === 2 ? 10 : week === 3 ? 15 : configured;
  return { cap: Math.min(configured, ramp), configured_cap: configured, week: Math.min(week, 4), start_date: start, days_elapsed: days };
}

export function normalizedDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.$/, '').split(/[/?#]/)[0];
  if (!domain || domain.length > 253 || !domain.includes('.') || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return '';
  return domain;
}

export function safeDkimSelector(value) {
  const selector = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,63}$/.test(selector) ? selector : '';
}

export function deceptiveSubjectReason(subject, hasPriorThread = false) {
  const value = String(subject || '').trim();
  if (!value) return 'Subject line is required.';
  if (!hasPriorThread && /^(?:re|fw|fwd)\s*:/i.test(value)) return 'A first email cannot imply an existing reply or forwarded conversation.';
  const misleading = [
    /\b(action required|urgent|final notice|payment overdue|invoice attached|account suspended|password reset|security alert)\b/i,
    /\b(guaranteed|risk[- ]free|100% free|limited time offer)\b/i,
  ];
  if (misleading.some((pattern) => pattern.test(value))) return 'Subject uses a misleading urgency, account, payment, or offer claim. Use an accurate, specific subject instead.';
  return '';
}

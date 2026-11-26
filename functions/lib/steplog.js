// Step-level logging: every pipeline transition is recorded to the DB.
// Never fail silently — every status change (queued, researching, drafted,
// scheduled, sent, failed, skipped) gets a row with error text.
// Also provides retry-with-backoff helpers and the global pause / review
// mode gate checks.

const nowIso = () => new Date().toISOString();

/**
 * Log a step transition to step_logs.
 * Always succeeds — if the insert itself fails, the error is swallowed
 * to avoid cascading failures, but the caller's own error handling still
 * records the failure in the job/email row.
 */
export async function logStep(DB, contactId, stepNumber, status, detail = '', error = '', component = 'pipeline') {
  try {
    await DB.prepare(
      'INSERT INTO step_logs(contact_id,step_number,status,detail,error,component,created_at) VALUES(?,?,?,?,?,?,?)'
    ).bind(contactId, stepNumber, status, String(detail || '').slice(0, 500), String(error || '').slice(0, 500), component, nowIso()).run();
  } catch {
    // Logging must never break the pipeline
  }
}

/**
 * Get the current global pause state from settings.
 * Returns true if sending is paused globally.
 */
export async function isGlobalPaused(DB) {
  const row = await DB.prepare("SELECT value FROM settings WHERE key='global_pause'").first();
  return String(row?.value || 'off') === 'on';
}

/**
 * Get the current review mode state from settings.
 * Returns true if drafts should wait for manual approval before sending.
 */
export async function isReviewMode(DB) {
  const row = await DB.prepare("SELECT value FROM settings WHERE key='review_mode'").first();
  return String(row?.value || 'off') === 'on';
}

/**
 * Compute backoff delay in seconds for a given attempt number.
 * Exponential backoff: 60s, 300s, 900s (1min, 5min, 15min) capped at 15 min.
 */
export function backoffSeconds(attempt) {
  const a = Number(attempt) || 1;
  if (a <= 1) return 60;
  if (a === 2) return 300;
  if (a === 3) return 900;
  return 900; // cap at 15 minutes
}

/**
 * Compute the next retry time as an ISO string based on backoff.
 */
export function nextRetryAt(attempt, from = new Date()) {
  const delay = backoffSeconds(attempt) * 1000;
  return new Date(from.getTime() + delay).toISOString();
}

/**
 * Mark a failed email for retry with backoff, or flag it if attempts exceeded.
 * Returns { retry: bool, retry_at: string|null, flagged: bool }.
 */
export async function scheduleRetryOrFlag(DB, emailId, error, maxAttempts = 3) {
  const prior = await DB.prepare(
    "SELECT COALESCE(MAX(attempt_number),0) AS n FROM email_send_attempts WHERE email_id=?"
  ).bind(emailId).first();
  const attemptNum = Number(prior?.n || 0);
  const nextAttempt = attemptNum + 1;

  if (nextAttempt <= maxAttempts) {
    const retryAt = nextRetryAt(nextAttempt);
    await DB.prepare(
      "UPDATE emails SET status='retry_wait',next_attempt_at=?,last_error=?,updated_at=? WHERE id=?"
    ).bind(retryAt, String(error || '').slice(0, 500), nowIso(), emailId).run();
    await logStep(DB, 0, 0, 'retrying', `Retry attempt ${nextAttempt} scheduled at ${retryAt}`, String(error || '').slice(0, 300), 'retry');
    return { retry: true, retry_at: retryAt, flagged: false };
  }

  // Exceeded max attempts — flag as failed
  await DB.prepare(
    "UPDATE emails SET status='failed',last_error=?,updated_at=? WHERE id=?"
  ).bind(String(error || '').slice(0, 500), nowIso(), emailId).run();
  await logStep(DB, 0, 0, 'failed', `Exceeded ${maxAttempts} retry attempts. Flagged for manual review.`, String(error || '').slice(0, 300), 'retry');
  return { retry: false, retry_at: null, flagged: true };
}

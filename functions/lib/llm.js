// Minimal server-only LLM fallback chain. Secrets are read only from env bindings;
// no key or provider response body is returned to the browser.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ----------------------------------------------------------- diagnostics */

/**
 * Sanitize a provider response body for logging/diagnostics: collapse
 * whitespace, redact credential-shaped strings, truncate. Never echoes raw
 * provider text or anything resembling a key into error messages.
 */
export function sanitizeDiagnostics(text) {
  const raw = String(text || '');
  const redacted = raw.replace(
    /\b((?:sk|rk|pk|api[_-]?key|x[_-]?api[_-]?key|token|authorization|bearer|x-goog-api-key)["'\s:=\-]*)[A-Za-z0-9_.\-]{6,}/gi,
    '$1<redacted>'
  );
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Compact summary of rate-limit related response headers: Retry-After and
 * any x-ratelimit-* / ratelimit-* values. Returns '' when none are present.
 */
export function rateLimitHeaderSummary(headers) {
  const parts = [];
  try {
    for (const [k, v] of headers.entries()) {
      const lk = String(k).toLowerCase();
      if (lk === 'retry-after' || lk.startsWith('x-ratelimit-') || lk.startsWith('ratelimit-')) {
        parts.push(`${lk}=${String(v).slice(0, 80)}`);
      }
    }
  } catch {
    // Headers may be unavailable on some runtime errors.
  }
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

/**
 * One-line, sanitized description of a failed HTTP exchange: status,
 * rate-limit headers, and a truncated/redacted body excerpt.
 */
export function describeHttpError(provider, model, status, bodyText, headers) {
  const body = bodyText ? ` body="${sanitizeDiagnostics(bodyText)}"` : '';
  return `${provider} (${model}): HTTP ${status}${rateLimitHeaderSummary(headers)}${body}`;
}

/* ----------------------------------------------------------- cooldowns */

// In-isolate provider cooldowns. A provider that just returned 429/402/403/5xx
// is skipped by later calls in the same request/tick instead of burning
// subrequests on a known-bad provider. When a DB-backed cooldown store is
// supplied via options.cooldown, that store takes precedence (it survives
// isolate recycling across cron ticks).
const providerCooldowns = new Map(); // name -> { until, reason }
const COOLDOWN_TTL_MS = {
  429: 10 * 60 * 1000, // rate limited — retry after the window resets
  402: 30 * 60 * 1000, // payment/quota required — long cooldown
  403: 30 * 60 * 1000, // forbidden — long cooldown
  500: 2 * 60 * 1000,
  502: 2 * 60 * 1000,
  503: 2 * 60 * 1000,
  504: 2 * 60 * 1000,
};

/** Clear all in-memory cooldowns (diagnostics and tests). */
export function resetProviderCooldowns() {
  providerCooldowns.clear();
}

async function cooldownActive(name, cooldownStore) {
  if (cooldownStore?.isCoolingDown) {
    try { if (await cooldownStore.isCoolingDown(name)) return true; } catch { /* fall through */ }
  }
  const entry = providerCooldowns.get(name);
  return !!entry && entry.until > Date.now();
}

async function markCooldown(name, status, cooldownStore) {
  const ttl = COOLDOWN_TTL_MS[Number(status)] || 5 * 60 * 1000;
  providerCooldowns.set(name, { until: Date.now() + ttl, reason: `HTTP ${status}` });
  if (cooldownStore?.markCooldown) {
    try { await cooldownStore.markCooldown(name, ttl, `HTTP ${status}`); } catch { /* best effort */ }
  }
}

function providers(env) {
  const out = [];
  // Groq: FIRST — openai/gpt-oss-20b confirmed working (429 = rate limited, not 404)
  // The llama-3.x model names return 404 on this account, so use only gpt-oss-20b
  if (env.GROQ_API_KEY) {
    out.push({
      name: 'groq', key: env.GROQ_API_KEY,
      models: ['openai/gpt-oss-20b', 'qwen/qwen3-32b'],
    });
  }
  // Gemini: SECOND — stable flash models
  if (env.GEMINI_API_KEY) {
    out.push({
      name: 'gemini', key: env.GEMINI_API_KEY,
      models: [env.GEMINI_MODEL || 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    });
  }
  // OpenRouter: THIRD — known-good free models
  if (env.OPENROUTER_API_KEY) {
    out.push({
      name: 'openrouter', key: env.OPENROUTER_API_KEY,
      models: ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'],
    });
  }
  // APInex: LAST — free quota exhausted (402), only tried if all others fail
  if (env.APINEX_API_KEY) {
    out.push({
      name: 'apinex', key: env.APINEX_API_KEY,
      baseUrl: 'https://api.apinex.bond/v1',
      models: ['free/gpt-6-luna', 'free/qwen-3.8-max'],
    });
  }
  return out;
}

function buildRequest(provider, model, messages, maxTokens, temperature) {
  if (provider.name === 'gemini') {
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': provider.key },
      body: { systemInstruction: { parts: [{ text: system }] }, contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature } },
      parse: (data) => (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim(),
    };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` };
  let url = provider.baseUrl
    ? `${provider.baseUrl}/chat/completions`
    : 'https://api.groq.com/openai/v1/chat/completions';
  if (provider.name === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['HTTP-Referer'] = 'https://origami.consulting';
    headers['X-Title'] = 'OrigamiOutreach';
  }
  return {
    url, headers,
    body: { model, messages, max_tokens: maxTokens, temperature },
    parse: (data) => {
      const msg = data.choices?.[0]?.message || {};
      // Reasoning models (gpt-oss) may put content in reasoning_content or reasoning
      const content = msg.content || msg.reasoning_content || msg.reasoning || '';
      return String(content || '').trim();
    },
  };
}

export function configuredProviders(env = {}) {
  return providers(env).map(({ name, models }) => ({ name, model: models[0] }));
}

export async function checkProviderConnectivity(env) {
  const chain = providers(env || {});
  const results = [];
  for (const provider of chain) {
    const baseUrl = provider.name === 'gemini'
      ? 'https://generativelanguage.googleapis.com'
      : provider.baseUrl || (provider.name === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.groq.com/openai/v1');
    try {
      const resp = await fetch(baseUrl, { method: 'GET' });
      results.push({ provider: provider.name, baseUrl, reachable: true, status: resp.status });
    } catch (e) {
      results.push({ provider: provider.name, baseUrl, reachable: false, error: String(e?.message || e).slice(0, 300) });
    }
  }
  return results;
}

async function readBody(response) {
  try { return await response.text(); } catch { return ''; }
}

export async function generateWithFallback(env, messages, options = {}) {
  const chain = providers(env || {});
  if (!chain.length) {
    const error = new Error('No LLM provider is configured');
    error.code = 'NO_PROVIDER';
    throw error;
  }
  const maxTokens = Math.max(1, Math.min(Number(options.maxTokens) || 500, 2000));
  const temperature = Math.max(0, Math.min(Number(options.temperature ?? 0.2), 1));
  const failures = [];
  // Cloudflare Pages Functions have a fixed subrequest limit that cannot be
  // reliably raised via wrangler.jsonc. Keep MAX_SUBREQUESTS very low. Every
  // HTTP call is counted, including bounded retries (at most one extra
  // attempt per model on 429/5xx). Stop immediately on subrequest errors.
  const MAX_SUBREQUESTS = Math.max(1, Number(options.maxSubrequests) || 4);
  const maxRetries = Math.max(0, Math.min(Number(options.maxRetries ?? 1), 2));
  const retryBaseMs = Math.max(0, Number(options.retryBaseMs ?? 500));
  const retryCapMs = Math.max(0, Number(options.retryCapMs ?? 5000));
  const cooldownStore = options.cooldown || null;
  const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : null;

  const record = async (provider, model, attempt, status, ok, errorText, startedAt) => {
    if (!onAttempt) return;
    try {
      await onAttempt({
        provider, model, attempt, status, ok,
        error: errorText ? String(errorText).slice(0, 500) : '',
        latencyMs: Date.now() - startedAt,
      });
    } catch {
      // Metrics must never break generation.
    }
  };

  const attemptBackoffMs = (retryAfterSec, attempt) => {
    if (Number(retryAfterSec) > 0) return Math.min(Number(retryAfterSec) * 1000, retryCapMs);
    return Math.min(retryBaseMs * Math.pow(2, attempt - 1), retryCapMs);
  };

  let subrequests = 0;
  let hitSubrequestLimit = false;

  for (const provider of chain) {
    if (hitSubrequestLimit) {
      failures.push(`${provider.name}: skipped — subrequest limit already reached`);
      break;
    }
    // Provider cooldown: skip providers that recently failed with
    // 429/402/403/5xx instead of burning subrequests on a known-bad provider.
    if (await cooldownActive(provider.name, cooldownStore)) {
      failures.push(`${provider.name}: skipped — provider in cooldown`);
      continue;
    }
    let providerSkipped = false;
    for (const model of provider.models) {
      if (subrequests >= MAX_SUBREQUESTS) {
        failures.push(`${provider.name}: subrequest limit reached, skipping remaining models`);
        hitSubrequestLimit = true;
        break;
      }
      if (providerSkipped) break;
      if (typeof options.reserve === 'function') {
        let allowed = false;
        try { allowed = await options.reserve(provider.name); } catch { allowed = false; }
        if (!allowed) { failures.push(`${provider.name}: configured quota cap reached`); providerSkipped = true; break; }
      }
      const req = buildRequest(provider, model, messages, maxTokens, temperature);
      // Bounded attempts per model: 1 initial + up to maxRetries on
      // 429/5xx, each counted against the subrequest cap.
      for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
        if (subrequests >= MAX_SUBREQUESTS) { hitSubrequestLimit = true; break; }
        subrequests++;
        const startedAt = Date.now();
        let response;
        try {
          response = await fetch(req.url, {
            method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
          });
        } catch (e) {
          const msg = String(e?.message || e);
          // Cloudflare throws "Too many subrequests" as a caught fetch error.
          // Stop immediately — trying more providers will only make it worse.
          await record(provider.name, model, attempt, 0, false, msg, startedAt);
          if (/subrequest/i.test(msg)) {
            failures.push(`${provider.name} (${model}): ${msg.slice(0, 200)}`);
            hitSubrequestLimit = true;
          } else {
            failures.push(`${provider.name} (${model}): ${e?.name || 'Error'}: ${msg.slice(0, 200)}`);
          }
          break;
        }
        // 404 means model not found — try next model in the list
        if (response.status === 404) {
          await record(provider.name, model, attempt, 404, false, 'HTTP 404 model not found', startedAt);
          failures.push(`${provider.name} (${model}): HTTP 404 model not found`);
          break;
        }
        // 401/402/403 — auth/billing/forbidden: skip all remaining models
        // for this provider, cool the provider down, log sanitized details.
        if ([401, 402, 403].includes(response.status)) {
          await markCooldown(provider.name, response.status, cooldownStore);
          const detail = await readBody(response);
          await record(provider.name, model, attempt, response.status, false, `HTTP ${response.status}`, startedAt);
          failures.push(describeHttpError(provider.name, model, response.status, detail, response.headers));
          providerSkipped = true;
          break;
        }
        // 429 rate limited / 5xx transient: bounded retry with backoff
        // (Retry-After respected, capped), then move to the next provider.
        if ((response.status === 429 || response.status >= 500) && attempt <= maxRetries) {
          const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
          await record(provider.name, model, attempt, response.status, false, `HTTP ${response.status} rate/transient`, startedAt);
          const delay = attemptBackoffMs(retryAfter, attempt);
          if (delay > 0) await sleep(delay);
          continue;
        }
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            await markCooldown(provider.name, response.status, cooldownStore);
            // The provider is cooling down — skip its remaining models too
            // and move to the next provider in the chain.
            providerSkipped = true;
          }
          const detail = await readBody(response);
          await record(provider.name, model, attempt, response.status, false, `HTTP ${response.status}`, startedAt);
          failures.push(describeHttpError(provider.name, model, response.status, detail, response.headers));
          if (response.status >= 500) providerSkipped = true;
          break;
        }
        let data;
        try { data = await response.json(); } catch {
          await record(provider.name, model, attempt, response.status, false, 'invalid response', startedAt);
          failures.push(`${provider.name} (${model}): invalid response`);
          break;
        }
        const text = req.parse(data);
        if (text) {
          await record(provider.name, model, attempt, response.status, true, '', startedAt);
          if (cooldownStore?.clearCooldown) {
            try { await cooldownStore.clearCooldown(provider.name); } catch { /* best effort */ }
          }
          return { text, provider: provider.name, model };
        }
        await record(provider.name, model, attempt, response.status, false, 'empty response', startedAt);
        failures.push(`${provider.name} (${model}): empty response`);
        break;
      }
      if (hitSubrequestLimit) break;
    }
    if (hitSubrequestLimit) break;
  }
  const error = new Error('All configured LLM providers failed: ' + failures.join('; '));
  error.code = 'ALL_PROVIDERS_FAILED';
  throw error;
}

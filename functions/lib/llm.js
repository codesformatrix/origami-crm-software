// Minimal server-only LLM fallback chain. Secrets are read only from env bindings;
// no key or provider response body is returned to the browser.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providers(env) {
  const out = [];
  // APInex: primary provider — OpenAI-compatible gateway with free models, 1M context
  if (env.APINEX_API_KEY) {
    out.push({
      name: 'apinex', key: env.APINEX_API_KEY,
      baseUrl: 'https://api.apinex.bond/v1',
      models: [
        'free/gpt-6-luna',
        'free/qwen-3.8-max',
        'free/glm-5.3-flash',
        'free/gemini-4-hydrogen',
        'free/deepseek-v4.1-flash',
        'free/kimi-k3',
      ],
    });
  }
  // Groq: try llama-3.3-70b-versatile first, fall back to llama-3.1-8b-instant if 404
  if (env.GROQ_API_KEY) {
    out.push({
      name: 'groq', key: env.GROQ_API_KEY,
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    });
  }
  if (env.GEMINI_API_KEY) {
    out.push({
      name: 'gemini', key: env.GEMINI_API_KEY,
      models: [env.GEMINI_MODEL || 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    });
  }
  if (env.OPENROUTER_API_KEY) {
    // Always use known-good free models — the env var may contain an invalid model name
    out.push({
      name: 'openrouter', key: env.OPENROUTER_API_KEY,
      models: ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'],
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
  // Cloudflare Workers limits subrequests per invocation. Cap total fetch attempts
  // to stay well under the limit — skip remaining models for a provider once we
  // hit a non-retryable error (402, 403, 401) instead of burning subrequests.
  const MAX_SUBREQUESTS = 8;
  let subrequests = 0;

  for (const provider of chain) {
    let providerSkipped = false;
    for (const model of provider.models) {
      if (subrequests >= MAX_SUBREQUESTS) {
        failures.push(`${provider.name}: subrequest limit reached, skipping remaining models`);
        break;
      }
      if (providerSkipped) break;
      if (typeof options.reserve === 'function') {
        let allowed = false;
        try { allowed = await options.reserve(provider.name); } catch { allowed = false; }
        if (!allowed) { failures.push(`${provider.name}: configured quota cap reached`); providerSkipped = true; break; }
      }
      const req = buildRequest(provider, model, messages, maxTokens, temperature);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (subrequests >= MAX_SUBREQUESTS) break;
        subrequests++;
        let response;
        try {
          response = await fetch(req.url, {
            method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
          });
        } catch (e) {
          failures.push(`${provider.name} (${model}): ${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 200)}`);
          break;
        }
        // 404 means model not found — try next model in the list
        if (response.status === 404) {
          failures.push(`${provider.name} (${model}): HTTP 404 model not found`);
          break;
        }
        // 402 (payment required) or 403 (forbidden) — provider-level failure,
        // skip all remaining models for this provider
        if (response.status === 402 || response.status === 403 || response.status === 401) {
          failures.push(`${provider.name} (${model}): HTTP ${response.status} — skipping remaining ${provider.models.length - 1} models for this provider`);
          providerSkipped = true;
          break;
        }
        if (response.status === 429 && attempt < 2) {
          await sleep(10000 * (2 ** attempt));
          continue;
        }
        if (!response.ok) {
          failures.push(`${provider.name} (${model}): HTTP ${response.status}`);
          break;
        }
        let data;
        try { data = await response.json(); } catch {
          failures.push(`${provider.name} (${model}): invalid response`);
          break;
        }
        const text = req.parse(data);
        if (text) return { text, provider: provider.name, model };
        failures.push(`${provider.name} (${model}): empty response`);
        break;
      }
    }
  }
  const error = new Error('All configured LLM providers failed: ' + failures.join('; '));
  error.code = 'ALL_PROVIDERS_FAILED';
  throw error;
}

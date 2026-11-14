// Minimal server-only LLM fallback chain. Secrets are read only from env bindings;
// no key or provider response body is returned to the browser.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providers(env) {
  const out = [];
  if (env.GROQ_API_KEY) out.push({ name: 'groq', key: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'openai/gpt-oss-120b' });
  if (env.GEMINI_API_KEY) out.push({ name: 'gemini', key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-2.5-flash' });
  if (env.OPENROUTER_API_KEY && String(env.OPENROUTER_MODEL || '').endsWith(':free')) out.push({ name: 'openrouter', key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL });
  return out;
}

function requestFor(provider, messages, maxTokens, temperature) {
  if (provider.name === 'gemini') {
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': provider.key },
      body: { systemInstruction: { parts: [{ text: system }] }, contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature } },
      parse: (data) => (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim(),
    };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` };
  let url = 'https://api.groq.com/openai/v1/chat/completions';
  if (provider.name === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['HTTP-Referer'] = 'https://origami.consulting';
    headers['X-Title'] = 'OrigamiOutreach';
  }
  return {
    url, headers,
    body: { model: provider.model, messages, max_tokens: maxTokens, temperature },
    parse: (data) => String(data.choices?.[0]?.message?.content || '').trim(),
  };
}

export function configuredProviders(env = {}) {
  return providers(env).map(({ name, model }) => ({ name, model }));
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
  for (const provider of chain) {
    const req = requestFor(provider, messages, maxTokens, temperature);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (typeof options.reserve === 'function') {
        let allowed = false;
        try { allowed = await options.reserve(provider.name); } catch { allowed = false; }
        if (!allowed) { failures.push(provider.name + ': configured quota cap reached'); break; }
      }
      let response;
      try {
        response = await fetch(req.url, {
          method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
        });
      } catch {
        failures.push(provider.name + ': network error');
        break;
      }
      if (response.status === 429 && attempt < 2) {
        await sleep(250 * (2 ** attempt));
        continue;
      }
      if (!response.ok) {
        failures.push(provider.name + ': HTTP ' + response.status);
        break;
      }
      let data;
      try { data = await response.json(); } catch {
        failures.push(provider.name + ': invalid response');
        break;
      }
      const text = req.parse(data);
      if (text) return { text, provider: provider.name, model: provider.model };
      failures.push(provider.name + ': empty response');
      break;
    }
  }
  const error = new Error('All configured LLM providers failed: ' + failures.join('; '));
  error.code = 'ALL_PROVIDERS_FAILED';
  throw error;
}

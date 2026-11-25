import assert from 'node:assert/strict';
import { configuredProviders, generateWithFallback } from '../functions/lib/llm.js';

const originalFetch = globalThis.fetch;
try {
  assert.deepEqual(configuredProviders({}), []);
  let groqCalls = 0, geminiCalls = 0, routerCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) {
      groqCalls++;
      assert.equal(options.headers.Authorization, 'Bearer secret-groq');
      return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
    }
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      assert.equal(options.headers['x-goog-api-key'], 'secret-gemini');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini fallback response' }] } }] }), { status: 200 });
    }
    if (String(url).includes('openrouter.ai')) { routerCalls++; throw new Error('should not reach OpenRouter'); }
    throw new Error('unexpected provider URL ' + url);
  };
  const env = {
    GROQ_API_KEY: 'secret-groq', GEMINI_API_KEY: 'secret-gemini',
    OPENROUTER_API_KEY: 'secret-router', OPENROUTER_MODEL: 'model:free',
  };
  const result = await generateWithFallback(env, [{ role: 'user', content: 'test' }], { maxTokens: 12 });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.text, 'Gemini fallback response');
  assert.equal(groqCalls, 3, '429 should back off and retry exponentially before falling through');
  assert.equal(geminiCalls, 1);
  assert.equal(routerCalls, 0);
  assert.deepEqual(configuredProviders(env).map((p) => p.name), ['groq', 'gemini', 'openrouter']);

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OpenRouter response' } }] }), { status: 200 });
  const fallback = await generateWithFallback({ OPENROUTER_API_KEY: 'secret-router', OPENROUTER_MODEL: 'model:free' }, [{ role: 'user', content: 'test' }]);
  assert.equal(fallback.provider, 'openrouter');
  assert.equal(fallback.text, 'OpenRouter response');

  await assert.rejects(() => generateWithFallback({}, [{ role: 'user', content: 'test' }]), (error) => error.code === 'NO_PROVIDER');
  console.log('PASS LLM provider order, server-only keys, 429 exponential retries, fallback parsing, and no-provider fail-closed behavior');
} finally {
  globalThis.fetch = originalFetch;
}

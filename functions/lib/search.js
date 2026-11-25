// Real web search via Tavily or Serper API.
// Falls back gracefully to LLM-based search when neither is configured.
// Each search returns structured results: title, url, content snippet.

import { generateWithFallback } from './llm.js';

/**
 * Run a real web search using Tavily or Serper.
 * Returns { results: [{title,url,content}], source, note }.
 * Falls back to LLM memory-based search if neither API key is set.
 */
export async function realWebSearch(env, queries) {
  const qs = Array.isArray(queries) ? queries : [queries];
  const allResults = [];

  if (env.TAVILY_API_KEY) {
    for (const q of qs) {
      try {
        const r = await tavilySearch(env.TAVILY_API_KEY, q);
        allResults.push(...r);
      } catch (e) {
        // Continue to next query or fallback
      }
    }
    if (allResults.length) {
      return { results: allResults, source: 'tavily', note: `Tavily returned ${allResults.length} results` };
    }
  }

  if (env.SERPER_API_KEY) {
    for (const q of qs) {
      try {
        const r = await serperSearch(env.SERPER_API_KEY, q);
        allResults.push(...r);
      } catch (e) {
        // Continue
      }
    }
    if (allResults.length) {
      return { results: allResults, source: 'serper', note: `Serper returned ${allResults.length} results` };
    }
  }

  // Fallback: LLM-based search (not real web, but uses provider knowledge)
  try {
    return await llmFallbackSearch(env, qs);
  } catch (e) {
    return { results: [], source: 'none', note: 'No search API configured and LLM search failed: ' + String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Deep research: run multiple targeted searches and compile findings.
 * Searches for: company site, funding news, hiring, founder posts.
 * Returns { summary, sources, facts }.
 */
export async function deepResearch(env, companyName, companyDomain, prospectName) {
  const queries = [];
  if (companyName) {
    queries.push(`${companyName} ${companyDomain ? '(' + companyDomain + ')' : ''} latest news 2025 2026`);
    queries.push(`${companyName} funding investment announcement`);
    queries.push(`${companyName} hiring jobs engineering`);
  }
  if (prospectName) {
    queries.push(`${prospectName} ${companyName || ''} founder co-founder latest`);
  }

  const search = await realWebSearch(env, queries);
  const results = search.results || [];
  const sources = results.slice(0, 8).map((r) => ({ url: r.url, title: r.title }));

  // Compile a summary from the top results
  const facts = results.slice(0, 5).map((r) => r.content || r.title || '');
  const summary = facts.filter(Boolean).join('\n');

  return {
    summary,
    sources,
    facts,
    source_api: search.source,
    note: search.note,
  };
}

async function tavilySearch(apiKey, query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      search_depth: 'advanced',
      include_answer: false,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || r.snippet || '',
  }));
}

async function serperSearch(apiKey, query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      num: 5,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Serper ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.organic || []).map((r) => ({
    title: r.title || '',
    url: r.link || '',
    content: r.snippet || '',
  }));
}

async function llmFallbackSearch(env, queries) {
  if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    return { results: [], source: 'none', note: 'No search API or LLM provider configured' };
  }
  const system = 'You are a web research assistant. Provide the latest publicly available information about the given queries. Return JSON: {"results":[{"title":"...","url":"...","content":"..."}]}. Use only real, verifiable information. If you are unsure, say so in the content field.';
  const user = JSON.stringify({ queries });
  const response = await generateWithFallback(env, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 800, temperature: 0.2 });
  const parsed = safeJson(response.text);
  return {
    results: Array.isArray(parsed.results) ? parsed.results : [],
    source: 'llm',
    note: 'LLM fallback search (no real search API configured)',
  };
}

function safeJson(text) {
  try {
    const cleaned = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { results: [] };
  }
}

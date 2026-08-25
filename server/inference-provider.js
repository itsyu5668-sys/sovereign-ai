'use strict';

// Multi-provider inference with fallback.
//
// Providers are tried in order; on a 429 (rate limit) the request falls
// through to the next provider. Other errors (bad key, 5xx, network) also
// fall through — a user should get an answer from whoever can serve one.
// A provider with no API key configured is skipped entirely.
//
// Rough free-tier capacity per provider (why the order is what it is):
//  1. Groq     — ~1,000 req/day, fast
//  2. Cerebras — ~1M tokens/day, but hard-capped at 8,192 context tokens
//                per request, so oversized prompts skip it entirely.
//  3. Gemini   — ~1,500 req/day. NOTE: prompts sent to Gemini's free tier
//                may be used by Google to improve their products (their
//                terms, not ours) — unlike Groq and Cerebras. See README.

const CEREBRAS_MAX_CONTEXT_TOKENS = 8192;
const SYSTEM_PROMPT = 'You are SovereignAI, a concise and accurate coding assistant.';
const REQUEST_TIMEOUT_MS = 30_000;

const providers = [
  {
    name: 'groq',
    key: () => process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  },
  {
    name: 'cerebras',
    key: () => process.env.CEREBRAS_API_KEY,
    url: 'https://api.cerebras.ai/v1/chat/completions',
    model: () => process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
    maxContextTokens: CEREBRAS_MAX_CONTEXT_TOKENS,
  },
  {
    name: 'gemini',
    key: () => process.env.GEMINI_API_KEY,
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
];

// Cheap heuristic (~4 chars/token) — only used to decide whether Cerebras'
// 8,192-token context cap can hold prompt + expected response.
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function callProvider(provider, prompt) {
  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.key()}`,
    },
    body: JSON.stringify({
      model: provider.model(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 429) {
    const err = new Error(`${provider.name} rate limited`);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${provider.name} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content;
  if (!answer) throw new Error(`${provider.name} returned an empty answer`);
  return answer;
}

// Returns { answer, provider } or throws if every provider failed.
async function generateAnswer(prompt, log) {
  const errors = [];

  for (const provider of providers) {
    if (!provider.key()) continue; // no key configured — skip silently

    if (
      provider.maxContextTokens &&
      estimateTokens(prompt) + estimateTokens(SYSTEM_PROMPT) + 2048 > provider.maxContextTokens
    ) {
      log?.info({ provider: provider.name }, 'prompt too large for provider context cap, skipping');
      continue;
    }

    try {
      const answer = await callProvider(provider, prompt);
      return { answer, provider: provider.name };
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      if (!err.rateLimited) log?.warn({ err }, `${provider.name} failed, trying next provider`);
    }
  }

  const err = new Error('all inference providers failed');
  err.details = errors;
  throw err;
}

function hasAnyProvider() {
  return providers.some((p) => p.key());
}

module.exports = { generateAnswer, hasAnyProvider };

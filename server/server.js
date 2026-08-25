'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const Groq = require('groq-sdk');
const { checkQuota, recordQuery } = require('./quota-store');
const { getAd } = require('./ad-provider');

const app = Fastify({ logger: true });

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

app.get('/health', async () => ({ status: 'ok' }));

app.post('/api/v1/query', async (request, reply) => {
  const { userId, prompt } = request.body || {};
  if (!userId || typeof userId !== 'string') {
    return reply.code(400).send({ error: 'bad_request', message: 'Missing userId.' });
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return reply.code(400).send({ error: 'bad_request', message: 'Missing prompt.' });
  }

  const quota = await checkQuota(userId);
  if (!quota.allowed) {
    return reply.code(402).send({
      error: 'quota_exceeded',
      message:
        `You've used all ${quota.limit} free queries for today. ` +
        'To keep going, set your own Groq API key (free at console.groq.com): ' +
        'export GROQ_API_KEY=your_key — the CLI will then use your key directly with no daily limit.',
      remaining: 0,
      limit: quota.limit,
    });
  }

  if (!groq) {
    return reply.code(503).send({
      error: 'backend_not_configured',
      message: 'The server has no GROQ_API_KEY configured. Ask the operator to set it, or use your own key (export GROQ_API_KEY).',
    });
  }

  let answer;
  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'You are SovereignAI, a concise and accurate coding assistant.' },
        { role: 'user', content: prompt },
      ],
    });
    answer = completion.choices?.[0]?.message?.content;
  } catch (err) {
    request.log.error(err, 'Groq request failed');
    return reply.code(502).send({
      error: 'ai_backend_error',
      message: 'The AI backend failed to answer. Nothing was charged against your quota — please try again.',
    });
  }
  if (!answer) {
    return reply.code(502).send({
      error: 'ai_backend_error',
      message: 'The AI backend returned an empty answer. Nothing was charged against your quota — please try again.',
    });
  }

  // Only count the query after a successful answer, so failures are free.
  const usage = await recordQuery(userId);

  const ad = await getAd();
  const response = ad ? answer + '\n' + ad : answer;

  return reply.send({ response, remaining: usage.remaining, limit: usage.limit });
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

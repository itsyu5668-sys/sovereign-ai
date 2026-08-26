'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const { checkQuota, recordQuery } = require('./quota-store');
const { getAd } = require('./ad-provider');
const { generateAnswer, hasAnyProvider } = require('./inference-provider');

const app = Fastify({ logger: true });

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
        'They reset at midnight UTC. Heavy user? Set your own GROQ_API_KEY for no daily limit.',
      remaining: 0,
      limit: quota.limit,
    });
  }

  if (!hasAnyProvider()) {
    return reply.code(503).send({
      error: 'backend_not_configured',
      message: 'The server has no inference provider configured. Ask the operator to set one, or use your own key (export GROQ_API_KEY).',
    });
  }

  let answer;
  try {
    ({ answer } = await generateAnswer(prompt, request.log));
  } catch (err) {
    request.log.error({ details: err.details }, 'all inference providers failed');
    return reply.code(502).send({
      error: 'ai_backend_error',
      message: 'The AI backend failed to answer. Nothing was charged against your quota — please try again.',
    });
  }

  // Only count the query after a successful answer, so failures are free.
  const usage = await recordQuery(userId);

  const ad = await getAd(prompt);
  const response = ad ? answer + '\n' + ad : answer;

  return reply.send({ response, remaining: usage.remaining, limit: usage.limit });
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

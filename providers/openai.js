// providers/openai.js
const { recordMetrics } = require('../metrics');

/**
 * Instrumented wrapper around OpenAI chat.completions.create
 * - Uses request-scoped circuit breaker if present
 * - Records call duration + tokens to Prometheus
 */
async function chatComplete(req, openai, params, { userTier = 'unknown' } = {}) {
  const endpoint = 'chat.completions';
  const started = Date.now();
  let success = false;
  let usageTokens = 0;

  const callFn = async () => {
    const res = await openai.chat.completions.create(params);
    const pt = Number(res?.usage?.prompt_tokens || 0);
    const ct = Number(res?.usage?.completion_tokens || 0);
    usageTokens = pt + ct;
    return res;
  };

  try {
    const runner = req?.circuitBreaker?.wrapOpenAI ? req.circuitBreaker.wrapOpenAI(callFn) : { fire: callFn };
    const res = await runner.fire();
    success = true;
    const content = res?.choices?.[0]?.message?.content || '';
    return { raw: res, content, usageTokens };
  } finally {
    try { recordMetrics.openaiCall(endpoint, Date.now() - started, success, usageTokens, userTier); } catch {}
  }
}

module.exports = { chatComplete };




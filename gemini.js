// gemini.js - Minimal Gemini API client using fetch
const { recordMetrics } = require('./metrics');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function jitter(ms){ return Math.max(0, Math.floor(ms * (0.85 + Math.random() * 0.3))); }

if (!GEMINI_API_KEY && process.env.NODE_ENV !== 'development') {
  console.warn('⚠️ GEMINI_API_KEY is not set; Gemini calls will fail in production');
}

async function generateContent({ text, system = null, model = GEMINI_MODEL, apiKey = GEMINI_API_KEY, timeoutMs = Number.isFinite((arguments[0]||{}).timeoutMs) ? Number((arguments[0]||{}).timeoutMs) : Number(process.env.GEMINI_TIMEOUT || 300000), thinkingBudget }) {
  const url = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const started = Date.now();
  let ok = false;
  let lastError;

  // Optional thinking config (2.5 Flash family supports disabling via budget: 0)
  const tb = (thinkingBudget === undefined || thinkingBudget === null || thinkingBudget === '') ? undefined : Number(thinkingBudget);
  const allowThinkingCfg = /2\.5/i.test(String(model)) && !/pro/i.test(String(model));
  const body = {
    contents: [
      {
        parts: [
          ...(system ? [{ text: String(system) }] : []),
          { text: String(text || '') }
        ]
      }
    ],
    ...(allowThinkingCfg && Number.isFinite(tb) ? { thinkingConfig: { thinkingBudget: Math.max(0, Math.floor(tb)) } } : {})
  };

  const maxAttempts = Number(process.env.GEMINI_MAX_ATTEMPTS || 2);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey || ''
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const json = await res.json().catch(() => ({}));
      ok = res.ok;
      if (!res.ok) {
        const msg = json?.error?.message || `Gemini error ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      const textOut = json?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('') || '';
      return { text: textOut, raw: json };
    } catch (e) {
      lastError = e;
      const status = e?.status;
      const isAbort = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
      const isRetryable = isAbort || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (attempt >= maxAttempts || !isRetryable) {
        break;
      }
      // Backoff with jitter
      let waitMs = jitter(Math.min(12000, 600 * (2 ** attempt)));
      await sleep(waitMs);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  try { recordMetrics.geminiCall('generateContent', Date.now() - started, ok, 0, 'unknown'); } catch {}
  throw lastError || new Error('Gemini request failed');
}

module.exports = {
  generateContent
};



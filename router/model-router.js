// router/model-router.js
/**
 * Decide which engine to use (Gemini 2.5 Flash-Lite / Gemini 2.5 Pro / GPT-4o)
 * based on text properties, mode, subStyle, in-prompt context and env flags.
 * Keep this light and deterministic; rely on QE + escalation for hard cases.
 */

const HARD_MODES = new Set(['legal','technical','medical','corporate','journalistic']);
const HIGH_CONTEXT = new Set(['dubbing','dialogue','subtitling']);
const CREATIVE = new Set(['marketing','creative','entertainment']);

function countDigits(s=''){ return (String(s).match(/\d/g) || []).length; }
function countEllipses(s=''){ return (String(s).match(/\.\.\./g) || []).length; }
function hasMultiLine(s=''){ return /\n{1,}/.test(String(s)); }
function lenScore(n){ if (n > 2800) return 1; if (n>1200) return 0.7; if (n>400) return 0.45; if (n>120) return 0.25; return 0.1; }

function riskScore({ text, mode, subStyle, injections, targetLanguage }) {
  const L = (text||'').length;
  const digits = countDigits(text);
  const ellips = countEllipses(text);
  const multiline = hasMultiLine(text);
  const m = String(mode||'').toLowerCase();
  const s = String(subStyle||'').toLowerCase();

  let score = 0;
  score += lenScore(L);
  if (digits >= 3) score += 0.12;
  if (ellips >= 1) score += 0.08;
  if (multiline) score += 0.12;
  if (HARD_MODES.has(m)) score += 0.28;
  if (HIGH_CONTEXT.has(m) || HIGH_CONTEXT.has(s)) score += 0.22;
  if (CREATIVE.has(m)) score += 0.10;
  if (injections && String(injections).trim().length > 0) score += 0.10; // brand/glossary present
  if (/zh|ja|ar|ru/.test(String(targetLanguage||'').toLowerCase())) score += 0.05; // tougher pairs

  return Math.min(1, Number(score.toFixed(3)));
}

function decideEngine({ text, mode, subStyle, targetLanguage, rephrase, injections, prefer='auto', allowPro = true }) {
  const rs = riskScore({ text, mode, subStyle, injections, targetLanguage });
  const reason = [];

  if (prefer && prefer !== 'auto') {
    return { engine: prefer, reason: `forced:${prefer}`, risk: rs };
  }

  const m = String(mode||'').toLowerCase();
  if (rephrase) return { engine: 'gemini-fl', reason: 'rephrase_speed', risk: rs };

  if (HARD_MODES.has(m)) {
    reason.push('hard_mode');
    if (allowPro) return { engine: 'gemini-2p', reason: reason.join('+'), risk: rs };
    // Pro disallowed → prefer GPT-4o for complex tasks
    return { engine: 'gpt-4o', reason: reason.concat('pro_disabled').join('+'), risk: rs };
  }

  if (rs >= 0.55) {
    reason.push('long_or_complex');
    if (allowPro) return { engine: 'gemini-2p', reason: reason.join('+'), risk: rs };
    // fallback to GPT-4o when pro disabled for high complexity
    return { engine: 'gpt-4o', reason: reason.concat('pro_disabled').join('+'), risk: rs };
  }

  if (CREATIVE.has(m) && String(targetLanguage||'').toLowerCase().startsWith('en')) {
    reason.push('creative_en');
    return { engine: 'gpt-4o', reason: reason.join('+'), risk: rs };
  }

  return { engine: 'gemini-fl', reason: 'fast_default', risk: rs };
}

function shouldCollaborate({ risk, mode }) {
  const committeeOn = (process.env.ROUTER_COMMITTEE_ENABLED || 'true') !== 'false';
  if (!committeeOn) return false;
  const m = String(mode||'').toLowerCase();
  if (risk >= 0.65) return true;
  if (HIGH_CONTEXT.has(m)) return true;
  return false;
}

module.exports = { decideEngine, shouldCollaborate, riskScore };



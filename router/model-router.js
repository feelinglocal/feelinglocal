// router/model-router.js
/**
 * Decide which engine to use (Gemini 2.5 Flash-Lite / Gemini 2.5 Pro / GPT-4o)
 * Policy requested:
 * - Simple text â†’ Gemini 2.5 Flash-Lite
 * - Long/complex or batch â†’ GPT-4o
 * - "Max localization" (allowPro) â†’ Gemini 2.5 Pro for domain styles
 */

const HARD_MODES = new Set(['legal', 'technical', 'medical', 'corporate', 'journalistic']);
const HIGH_CONTEXT = new Set(['dubbing', 'dialogue', 'subtitling']);
const CREATIVE = new Set(['marketing', 'creative', 'entertainment']);
const TERMINOLOGY_MODES = new Set(['legal', 'medical']);
const TERMINOLOGY_SUB_HINTS = ['contracts', 'terms', 'privacy', 'compliance', 'constitutional', 'clinical', 'patient', 'research'];

function countDigits(s = '') { return (String(s).match(/\d/g) || []).length; }
function countEllipses(s = '') { return (String(s).match(/\.\.\./g) || []).length; }
function hasMultiLine(s = '') { return /\n{1,}/.test(String(s)); }
function lenScore(n) { if (n > 2800) return 1; if (n > 1200) return 0.7; if (n > 400) return 0.45; if (n > 120) return 0.25; return 0.1; }

function riskScore({ text, mode, subStyle, injections, targetLanguage }) {
  const L = (text || '').length;
  const digits = countDigits(text);
  const ellips = countEllipses(text);
  const multiline = hasMultiLine(text);
  const m = String(mode || '').toLowerCase();
  const s = String(subStyle || '').toLowerCase();

  let score = 0;
  score += lenScore(L);
  if (digits >= 3) score += 0.12;
  if (ellips >= 1) score += 0.08;
  if (multiline) score += 0.12;
  if (HARD_MODES.has(m)) score += 0.28;
  if (HIGH_CONTEXT.has(m) || HIGH_CONTEXT.has(s)) score += 0.22;
  const isTerminologyHeavy = TERMINOLOGY_MODES.has(m) || TERMINOLOGY_SUB_HINTS.some(h => s.includes(h));
  if (isTerminologyHeavy) score += 0.3;
  if (CREATIVE.has(m)) score += 0.10;
  if (injections && String(injections).trim().length > 0) score += 0.10; // brand/glossary present
  if (/zh|ja|ar|ru/.test(String(targetLanguage || '').toLowerCase())) score += 0.05; // tougher pairs

  return Math.min(1, Number(score.toFixed(3)));
}

function decideEngine({ text, mode, subStyle, targetLanguage, rephrase, injections, prefer = 'auto', allowPro = true, isBatch = false }) {
  const rs = riskScore({ text, mode, subStyle, injections, targetLanguage });
  const reason = [];

  if (prefer && prefer !== 'auto') {
    return { engine: prefer, reason: `forced:${prefer}`, risk: rs };
  }

  const m = String(mode || '').toLowerCase();
  const s = String(subStyle || '').toLowerCase();
  if (isBatch) {
    // Batch policy: Gemini Flash by default; Gemini Pro when Max is ON
    if (allowPro) return { engine: 'gemini-2p', reason: 'batch+pro', risk: rs };
    return { engine: 'gemini-fl', reason: 'batch_default', risk: rs };
  }
  if (rephrase) return { engine: 'gemini-fl', reason: 'rephrase_speed', risk: rs };

  // Domain styles: use Pro only when Max is ON; otherwise Flash-Lite
  const isHighContext = HIGH_CONTEXT.has(m) || HIGH_CONTEXT.has(s);
  if (HARD_MODES.has(m) || isHighContext) {
    reason.push('hard_mode');
    if (allowPro) return { engine: 'gemini-2p', reason: reason.join('+'), risk: rs };
    return { engine: 'gemini-fl', reason: reason.concat('pro_disabled').join('+'), risk: rs };
  }

  // Long/complex text â†’ still use Gemini Flash (GPT disabled)
  if (rs >= 0.55) {
    reason.push('long_or_complex');
    return { engine: 'gemini-fl', reason: reason.join('+'), risk: rs };
  }

  // Creative English tasks â†’ Gemini Flash (GPT disabled)
  if (CREATIVE.has(m) && String(targetLanguage || '').toLowerCase().startsWith('en')) {
    reason.push('creative_en');
    return { engine: 'gemini-fl', reason: reason.join('+'), risk: rs };
  }

  // Default fast path
  return { engine: 'gemini-fl', reason: 'fast_default', risk: rs };
}

function shouldCollaborate({ risk, mode }) {
  const committeeOn = (process.env.ROUTER_COMMITTEE_ENABLED || 'true') !== 'false';
  if (!committeeOn) return false;
  const m = String(mode || '').toLowerCase();
  if (risk >= 0.65) return true;
  if (HIGH_CONTEXT.has(m)) return true;
  return false;
}

module.exports = { decideEngine, shouldCollaborate, riskScore };





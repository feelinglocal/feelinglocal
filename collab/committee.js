// collab/committee.js
/**
 * Collaboration helpers:
 *  - firstPassReview: primary engine produces draft, GPT-4o (or Gemini 2.5 Pro) reviews with STRICT JSON and we repair/escalate if needed.
 *  - committeeOfTwo: primary + secondary produce candidates; arbiter synthesizes best final.
 *
 * These functions are pure; pass in the runtime dependencies.
 */
const { recordMetrics, metrics } = require('../metrics');

function diffHeuristic(src='', out=''){
  const reasons = [];
  const srcNums = (String(src).match(/\d+(?:[.,]\d+)?/g) || []).length;
  const outNums = (String(out).match(/\d+(?:[.,]\d+)?/g) || []).length;
  if (srcNums !== outNums){ reasons.push('numeric_mismatch'); }

  const srcQ = (src.match(/\?/g)||[]).length;
  const outQ = (out.match(/\?/g)||[]).length;
  if (srcQ !== outQ){ reasons.push('question_punct_mismatch'); }

  const srcEll = (src.match(/\.\.\./g)||[]).length;
  const outEll = (out.match(/\.\.\./g)||[]).length;
  if (srcEll && !outEll){ reasons.push('ellipsis_missing'); }

  let score = 0.95;
  if (reasons.includes('numeric_mismatch')) score -= 0.25;
  if (reasons.includes('question_punct_mismatch')) score -= 0.15;
  if (reasons.includes('ellipsis_missing')) score -= 0.10;
  score = Math.max(0, Math.min(1, score));
  return [score, reasons];
}

function isRetryableError(e){
  const status = e?.status || e?.code;
  const isAbort = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
  return isAbort || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function runWithFallback(runWithEngine, engine, prompt, temperature, options = {}){
  try {
    return await runWithEngine(engine, prompt, temperature, options);
  } catch (e) {
  if (isRetryableError(e) && engine !== 'gemini-fl') {
      try { metrics.escalationsTotal.inc({ from: engine, to: 'gemini-fl', reason: 'fallback_retryable_committee' }); } catch {}
      return await runWithEngine('gemini-fl', prompt, Math.max(0.15, (temperature||0.3)-0.05), options);
  }
    throw e;
  }
}

async function firstPassReview(ctx, {
  srcText, promptBuilder, sanitizer, temperature, primaryEngine, runWithEngine,
  targetLanguage, mode, subStyle
}){
  // Ensure Gemini calls always get a long timeout (avoids aborts)
  const GEMINI_LONG_TMO = Number(process.env.GEMINI_TIMEOUT || 300000);
  const optsFor = (eng) => (String(eng || '').startsWith('gemini') ? { timeout: GEMINI_LONG_TMO } : {});

  const primary = await runWithFallback(runWithEngine, primaryEngine, promptBuilder(), temperature, optsFor(primaryEngine));
  const draft = sanitizer(primary.text || '', srcText, targetLanguage);

  const [score, reasons] = diffHeuristic(srcText, draft);
  const qeEnabled = (process.env.ROUTER_QE_ENABLED || 'true') !== 'false';
  const threshold = Number(process.env.ROUTER_QE_THRESHOLD || 0.72);
  try { metrics.qeScore.observe(score); } catch {}

  if (!qeEnabled || score >= threshold) {
    try { recordMetrics.collabSteps.inc({ step: 'review_pass', primary: primaryEngine, secondary: 'none', arbiter: 'none', outcome: 'accepted' }); } catch {}
    return { text: draft, meta: { committee: 'first_pass_review', score, reasons, primary: primaryEngine } };
  }

  const repairEngine = 'gemini-2p';
  const repaired = await runWithFallback(
    runWithEngine,
    repairEngine,
    promptBuilder(),
    Math.max(0.15, (temperature||0.3)-0.05),
    optsFor(repairEngine)
  );
  const repairedClean = sanitizer(repaired.text || '', srcText, targetLanguage);
  try {
    metrics.escalationsTotal.inc({ from: primaryEngine, to: repairEngine, reason: (reasons[0]||'qe_below_threshold') });
    metrics.collabSteps.inc({ step: 'repair', primary: primaryEngine, secondary: 'none', arbiter: 'none', outcome: 'repaired' });
  } catch {}
  return { text: repairedClean, meta: { committee: 'first_pass_review', score, reasons, primary: primaryEngine, repairedBy: repairEngine } };
}

async function committeeOfTwo(ctx, {
  srcText, promptBuilder, sanitizer, temperature, primaryEngine, secondaryEngine,
  arbiterEngine = 'gemini-2p', runWithEngine, targetLanguage
}){
  const GEMINI_LONG_TMO = Number(process.env.GEMINI_TIMEOUT || 300000);
  const optsFor = (eng) => (String(eng || '').startsWith('gemini') ? { timeout: GEMINI_LONG_TMO } : {});

  const [candA, candB] = await Promise.all([
    runWithFallback(runWithEngine, primaryEngine,  promptBuilder(), temperature, optsFor(primaryEngine)),
    runWithFallback(runWithEngine, secondaryEngine, promptBuilder(), temperature, optsFor(secondaryEngine))
  ]);

  const A = sanitizer(candA.text || '', srcText, targetLanguage);
  const B = sanitizer(candB.text || '', srcText, targetLanguage);

  const arbiterPrompt = (src, a, b) => `
You are an expert localization arbiter. Choose the BETTER of two candidates or synthesize an improved version that strictly preserves meaning, numbers, and punctuation style from the source.

Rules:
- Preserve source punctuation type (? ! ...) on corresponding lines.
- Preserve all numbers (digits stay digits unless target locale mandates otherwise).
- Prefer natural, native phrasing in ${targetLanguage}; obey the requested mode/sub-style.
- If both are acceptable, choose the clearer/more idiomatic one.
- If both have issues, synthesize a corrected version combining the best parts.

Return only the final output between <result> and </result>.

SOURCE:
${src}

CANDIDATE_A:
${a}

CANDIDATE_B:
${b}

<result>
`.trim();

  const arb = await runWithFallback(
    runWithEngine,
    arbiterEngine,
    arbiterPrompt(srcText, A, B),
    Math.max(0.15, (temperature||0.3)-0.05),
    optsFor(arbiterEngine)
  );
  const finalClean = sanitizer(arb.text || '', srcText, targetLanguage);
  try { metrics.collabSteps.inc({ step: 'committee2', primary: primaryEngine, secondary: secondaryEngine, arbiter: arbiterEngine, outcome: 'finalized' }); } catch {}
  return { text: finalClean, meta: { committee: 'committee2', primary: primaryEngine, secondary: secondaryEngine, arbiter: arbiterEngine } };
}

module.exports = { firstPassReview, committeeOfTwo };


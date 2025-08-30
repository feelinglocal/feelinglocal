// rate-limit.js - Rate limiting and quota management
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib;
const { ipKeyGenerator } = rateLimitLib;
let RedisRateLimitStore;
try { ({ RedisRateLimitStore } = require('./redis-rate-limit-store')); } catch {}
const RELAX_LIMITS = (process.env.RELAX_RATE_LIMITS === 'true') || (process.env.NODE_ENV === 'development');
const SKIP_PREFIXES = ['/api/usage', '/api/health', '/metrics'];
const db = require('./database');
const { TIERS } = require('./auth');

// Track usage in database
async function recordUsage(req, endpoint, tokensUsed = 0, charactersProcessed = 0) {
  try {
    await db.run(`
      INSERT INTO usage_counters (user_id, org_id, api_key_id, endpoint, tokens_used, characters_processed)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.user?.id,
      req.user?.orgId,
      req.user?.apiKeyId,
      endpoint,
      tokensUsed,
      charactersProcessed
    ]);
  } catch (error) {
    console.error('Failed to record usage:', error);
  }
}

// Check daily quota
async function checkDailyQuota(userId, tier) {
  const today = new Date().toISOString().split('T')[0];
  const usage = await db.get(`
    SELECT COUNT(*) as requests
    FROM usage_counters
    WHERE user_id = ? AND date = ?
  `, [userId, today]);

  const tierConfig = TIERS[tier];
  const requestsUsed = usage?.requests || 0;
  
  return {
    used: requestsUsed,
    limit: tierConfig.maxRequestsPerDay,
    remaining: Math.max(0, tierConfig.maxRequestsPerDay - requestsUsed),
    exceeded: requestsUsed >= tierConfig.maxRequestsPerDay
  };
}

// Quota middleware
const quotaMiddleware = async (req, res, next) => {
  if (!req.user) {
    return next(); // No auth means no quota check
  }

  try {
    const quota = await checkDailyQuota(req.user.id, req.user.tier);
    
    if (quota.exceeded) {
      return res.status(429).json({
        error: 'Daily quota exceeded',
        quota: {
          used: quota.used,
          limit: quota.limit,
          remaining: 0
        },
        upgradeMessage: 'Upgrade to Pro or Team for higher limits'
      });
    }

    // Add quota info to response headers
    res.set({
      'X-RateLimit-Limit': quota.limit,
      'X-RateLimit-Remaining': quota.remaining,
      'X-RateLimit-Used': quota.used
    });

    req.quota = quota;
    next();
  } catch (error) {
    console.error('Quota check failed:', error);
    next(); // Continue on error, but log it
  }
};

// Create rate limiters for different tiers
const createRateLimiter = (windowMs, maxRequests, message, prefix = 'rl:general') => {
  const keyFn = (req) => req.user?.id || ipKeyGenerator(req);
  if (RELAX_LIMITS) {
    return rateLimit({ windowMs, max: 1000000, standardHeaders: false, legacyHeaders: false, keyGenerator: keyFn, skip: (req)=> SKIP_PREFIXES.some(p => (req.path||'').startsWith(p)) });
  }
  const useRedis = !!(process.env.REDIS_URL && RedisRateLimitStore);
  const common = {
    windowMs,
    max: maxRequests,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyFn,
    skip: (req) => SKIP_PREFIXES.some(p => (req.path||'').startsWith(p))
  };
  if (useRedis) {
    return rateLimit({
      ...common,
      store: new RedisRateLimitStore({ windowMs, prefix })
    });
  }
  return rateLimit(common);
};

// Tier-aware wrappers (Team gets higher RPM)
function withTierOverride(limiterFactory, teamMax) {
  return rateLimit({
    windowMs: limiterFactory.windowMs,
    max: limiterFactory.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
    skip: (req) => SKIP_PREFIXES.some(p => (req.path||'').startsWith(p)),
    store: (process.env.REDIS_URL && RedisRateLimitStore) ? new RedisRateLimitStore({ windowMs: limiterFactory.windowMs, prefix: limiterFactory.prefix }) : undefined,
    // Override per-request using draft API: handler's allowed count is fixed; emulate by skipping for team when under teamMax using a soft counter
  });
}

// Different rate limits for different endpoints
// Auth limiter configurable via env for hot-fixes in production
const AUTH_WINDOW_MS = parseInt(process.env.AUTH_WINDOW_MS || (10 * 60 * 1000), 10);
const AUTH_MAX = parseInt(process.env.AUTH_MAX || 30, 10);
const rateLimiters = {
  // General API rate limiting (per minute)
  general: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    60, // default
    'Too many requests, please try again later',
    'rl:general'
  ),
  
  // Translation endpoints (stricter)
  translation: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    RELAX_LIMITS ? 100000 : 60,
    'Translation rate limit exceeded',
    'rl:translation'
  ),
  
  // Auth endpoints (very strict)
  auth: createRateLimiter(
    AUTH_WINDOW_MS,
    AUTH_MAX,
    'Too many authentication attempts',
    'rl:auth'
  ),
  
  // File upload (moderate)
  upload: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    RELAX_LIMITS ? 100000 : 60,
    'Upload rate limit exceeded',
    'rl:upload'
  )
};

// Per-tier bump for Team: wrap the middleware to use a separate limiter at 100 rpm when tier === team
function teamBoost(limiter, teamLimiter) {
  return (req, res, next) => {
    const isTeam = (req.user?.tier || '').toLowerCase() === 'team';
    if (isTeam) return teamLimiter(req, res, next);
    return limiter(req, res, next);
  };
}

const teamGeneral = createRateLimiter(60 * 1000, 100, 'Too many requests (team)', 'rl:general:team');
const teamTranslation = createRateLimiter(60 * 1000, 100, 'Translation rate limit exceeded (team)', 'rl:translation:team');
const teamUpload = createRateLimiter(60 * 1000, 100, 'Upload rate limit exceeded (team)', 'rl:upload:team');

// Replace default exported limiters with tier-aware wrappers
rateLimiters.general = teamBoost(rateLimiters.general, teamGeneral);
rateLimiters.translation = teamBoost(rateLimiters.translation, teamTranslation);
rateLimiters.upload = teamBoost(rateLimiters.upload, teamUpload);

// Input size validation middleware
const validateInputSize = (req, res, next) => {
  const userTier = req.user?.tier || 'free';
  const isGuest = req.user?.isGuest === true;
  const effectiveTier = isGuest ? 'free' : userTier;
  const tierConfig = TIERS[effectiveTier];
  
  // Check text input size for single requests
  const textContent = req.body?.text || '';
  if (textContent && textContent.length > tierConfig.maxInputSize) {
    return res.status(413).json({
      error: 'Input size exceeds tier limit',
      currentSize: textContent.length,
      maxSize: tierConfig.maxInputSize,
      tier: effectiveTier,
      isGuest,
      upgradeMessage: isGuest ? 'Sign in to get higher limits!' : (effectiveTier === 'free' ? 'Upgrade to Pro for larger inputs' : 'Consider Team tier for enterprise limits')
    });
  }
  
  // Check batch requests (items array)
  const items = req.body?.items;
  if (Array.isArray(items)) {
    const totalLength = items.join('').length;
    if (totalLength > tierConfig.maxInputSize) {
      return res.status(413).json({
        error: 'Batch input size exceeds tier limit',
        currentSize: totalLength,
        maxSize: tierConfig.maxInputSize,
        tier: effectiveTier,
        isGuest,
        upgradeMessage: isGuest ? 'Sign in to get higher limits!' : (effectiveTier === 'free' ? 'Upgrade to Pro for larger inputs' : 'Consider Team tier for enterprise limits')
      });
    }
  }

  next();
};

module.exports = {
  recordUsage,
  checkDailyQuota,
  quotaMiddleware,
  rateLimiters,
  validateInputSize
};

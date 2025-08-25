// rate-limit.js - Rate limiting and quota management
const rateLimit = require('express-rate-limit');
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
const createRateLimiter = (windowMs, maxRequests, message) => {
  return rateLimit({
    windowMs,
    max: maxRequests,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false
    // Use default keyGenerator for proper IPv6 support
  });
};

// Different rate limits for different endpoints
// Auth limiter configurable via env for hot-fixes in production
const AUTH_WINDOW_MS = parseInt(process.env.AUTH_WINDOW_MS || (10 * 60 * 1000), 10);
const AUTH_MAX = parseInt(process.env.AUTH_MAX || 30, 10);
const rateLimiters = {
  // General API rate limiting (per minute)
  general: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    60, // 60 requests per minute
    'Too many requests, please try again later'
  ),
  
  // Translation endpoints (stricter)
  translation: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    30, // 30 requests per minute
    'Translation rate limit exceeded'
  ),
  
  // Auth endpoints (very strict)
  auth: createRateLimiter(
    AUTH_WINDOW_MS,
    AUTH_MAX,
    'Too many authentication attempts'
  ),
  
  // File upload (moderate)
  upload: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    10, // 10 uploads per minute
    'Upload rate limit exceeded'
  )
};

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

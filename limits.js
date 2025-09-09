// limits.js - Feature gates and quota enforcement
const db = require('./database');
const { TIERS } = require('./auth');
let Redis;
try { ({ Redis } = require('ioredis')); } catch {}
let redisClient = null;
function getRedis() {
  if (redisClient) return redisClient;
  if (process.env.REDIS_URL && Redis) {
    redisClient = new Redis(process.env.REDIS_URL, { lazyConnect: true });
    redisClient.on('error', () => {});
    try { redisClient.connect().catch(()=>{}); } catch {}
  }
  return redisClient;
}

function monthKeyNow() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`; // YYYY-MM
}

async function userLimitGet(userId, scope, k) {
  const mk = monthKeyNow();
  const r = getRedis();
  if (r) {
    const key = `user:${userId}:limits:${scope}:${mk}`;
    const v = await r.hget(key, k);
    return Number(v || 0);
  }
  const row = await db.get(`SELECT v FROM user_limits WHERE user_id = ? AND scope = ? AND month_key = ? AND k = ?`, [String(userId), String(scope), mk, String(k)]);
  return Number(row?.v || 0);
}

async function userLimitInc(userId, scope, k, delta = 1) {
  const mk = monthKeyNow();
  const r = getRedis();
  if (r) {
    const key = `user:${userId}:limits:${scope}:${mk}`;
    const v = await r.hincrby(key, k, delta);
    // Set TTL ~45 days to auto-expire monthly buckets
    await r.expire(key, 60 * 60 * 24 * 45);
    return Number(v || 0);
  }
  const row = await db.get(`SELECT v FROM user_limits WHERE user_id = ? AND scope = ? AND month_key = ? AND k = ?`, [String(userId), String(scope), mk, String(k)]);
  if (row) {
    await db.run(`UPDATE user_limits SET v = v + ? WHERE user_id = ? AND scope = ? AND month_key = ? AND k = ?`, [delta, String(userId), String(scope), mk, String(k)]);
  } else {
    await db.run(`INSERT INTO user_limits (user_id, scope, month_key, k, v) VALUES (?, ?, ?, ?, ?)`, [String(userId), String(scope), mk, String(k), Number(delta)]);
  }
  const newRow = await db.get(`SELECT v FROM user_limits WHERE user_id = ? AND scope = ? AND month_key = ? AND k = ?`, [String(userId), String(scope), mk, String(k)]);
  return Number(newRow?.v || 0);
}

async function getMonthlyCharsUsed(userId) {
  if (!userId) return 0;
  try {
    const row = await db.get(
      `SELECT COALESCE(SUM(characters_processed), 0) AS chars
       FROM usage_counters
       WHERE user_id = ?
         AND strftime('%Y-%m', date) = strftime('%Y-%m','now')`,
      [userId]
    );
    return Number(row?.chars || 0);
  } catch (e) {
    return 0;
  }
}

async function checkMonthlyQuota(userId, tier) {
  const used = await getMonthlyCharsUsed(userId);
  const tierConf = TIERS[tier] || TIERS.free;
  const limit = Number(tierConf.maxMonthlyChars || 0);
  return { used, limit, remaining: Math.max(0, limit - used), exceeded: used >= limit };
}

// Middleware to block requests when monthly cap reached
async function enforceMonthlyLimit(req, res, next) {
  try {
    if (!req.user?.id) return next(); // guests not tracked for monthly caps
    const tier = (req.user?.tier || 'free').toLowerCase();
    const quota = await checkMonthlyQuota(req.user.id, tier);
    if (quota.exceeded) {
      const isBusiness = tier === 'business';
      return res.status(402).json({
        error: isBusiness ? 'Business monthly character limit reached. Contact support to extend.' : 'Monthly character limit reached. Please upgrade.',
        code: 'month_quota_exceeded',
        quota: { used: quota.used, limit: quota.limit, remaining: 0 },
        upgradeMessage: isBusiness ? 'Contact sales to extend your Business quota' : 'Upgrade to Pro or Business for higher limits'
      });
    }
    return next();
  } catch (e) {
    return next();
  }
}

// Basic user flag helpers (e.g., free batch trial)
async function getUserFlag(userId, key) {
  try {
    return await db.get('SELECT value FROM user_flags WHERE user_id = ? AND key = ? LIMIT 1', [userId, key]);
  } catch {
    return null;
  }
}

async function setUserFlag(userId, key, value) {
  try {
    await db.run(
      `INSERT INTO user_flags (user_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, created_at = CURRENT_TIMESTAMP`,
      [userId, key, value]
    );
  } catch {}
}

// Allow one-time batch translation for Free tier
async function allowFreeBatchTrial(req, res, next) {
  try {
    const tier = (req.user?.tier || 'free').toLowerCase();
    if (tier !== 'free' || !req.user?.id) return next();
    const flag = await getUserFlag(req.user.id, 'free_batch_trial_used');
    if (!flag || String(flag.value) !== '1') {
      req.freeBatchTrialGranted = true;
    }
    return next();
  } catch (e) {
    return next();
  }
}

// Enforce single device per month for Free/Pro; Business unlimited.
async function enforceDeviceLimit(req, res, next) {
  try {
    const tier = (req.user?.tier || 'free').toLowerCase();
    if (!req.user?.id) return next(); // guests not enforced
    if (tier === 'business') return next();
    if (process.env.NODE_ENV !== 'production' && String(req.headers['x-admin-bypass']).toLowerCase() === 'true') return next();

    const deviceId = req.headers['x-device-id'];
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 6) {
      return res.status(400).json({ error: 'Missing X-Device-ID header', code: 'device_id_required' });
    }

    const userId = String(req.user.id);
    const monthKey = monthKeyNow();
    const r = getRedis();
    if (r) {
      const key = `user:${userId}:devices:${monthKey}`;
      const exists = await r.sismember(key, deviceId);
      if (!exists) {
        const count = await r.scard(key);
        if (count >= 1) {
          res.setHeader('X-Tier', tier);
          res.setHeader('X-Feature-Locked', 'devices');
          return res.status(403).json({
            error: 'Device limit reached for this account.',
            code: 'device_limit',
            upgradeMessage: 'Upgrade to Business for multi-device login.',
            helpUrl: 'https://example.com/pricing'
          });
        }
        await r.sadd(key, deviceId);
        await r.expire(key, 60 * 60 * 24 * 45);
      }
    } else {
      const row = await db.get(`SELECT 1 FROM user_devices WHERE user_id = ? AND month_key = ? AND device_id = ?`, [userId, monthKey, deviceId]);
      if (!row) {
        const cnt = await db.get(`SELECT COUNT(*) AS c FROM user_devices WHERE user_id = ? AND month_key = ?`, [userId, monthKey]);
        if (Number(cnt?.c || 0) >= 1) {
          res.setHeader('X-Tier', tier);
          res.setHeader('X-Feature-Locked', 'devices');
          return res.status(403).json({
            error: 'Device limit reached for this account.',
            code: 'device_limit',
            upgradeMessage: 'Upgrade to Business for multi-device login.',
            helpUrl: 'https://example.com/pricing'
          });
        }
        await db.run(`INSERT OR IGNORE INTO user_devices (user_id, month_key, device_id) VALUES (?, ?, ?)`, [userId, monthKey, deviceId]);
      }
    }

    return next();
  } catch (e) {
    return next();
  }
}

// Sub-style limiter: Free gets 5 uses/month; Pro/Business unlimited
async function enforceSubstyleAndMark(req, res) {
  try {
    const tier = (req.user?.tier || 'free').toLowerCase();
    if (tier !== 'free') return { locked: false };
    const hasSub = !!(req.body && typeof req.body.subStyle === 'string' && req.body.subStyle.trim());
    if (!hasSub) return { locked: false };
    const used = await userLimitGet(req.user.id, 'substyle', 'uses');
    if (used >= 5) {
      try { res.setHeader('X-Locked-Substyle', 'true'); } catch {}
      // Force disable on server
      if (req.body) req.body.subStyle = '';
      return { locked: true };
    }
    // Will increment after successful response by caller
    return { locked: false };
  } catch { return { locked: false }; }
}

// Track Max mode usage and set headers for remaining
async function prepareMaxModeHeaders(req, res) {
  const tier = (req.user?.tier || 'free').toLowerCase();
  const allowPro = !!req.body?.allowPro;
  let limit = 0;
  if (tier === 'pro') limit = 5; else if (tier === 'business') limit = 50; else limit = 0;
  let used = 0;
  if (allowPro && limit > 0 && req.user?.id) {
    used = await userLimitGet(req.user.id, 'maxmode', 'uses');
  }
  const remaining = Math.max(0, limit - used);
  try {
    res.setHeader('X-Max-Limit', String(limit));
    res.setHeader('X-Max-Remaining', String(remaining));
  } catch {}
  return { limit, used, remaining, shouldCount: allowPro && limit > 0 && req.user?.id };
}

async function countMaxModeUse(req, res) {
  try {
    const tier = (req.user?.tier || 'free').toLowerCase();
    if (!req.user?.id) return;
    if (tier !== 'pro' && tier !== 'business') return;
    if (!req.body?.allowPro) return;
    await userLimitInc(req.user.id, 'maxmode', 'uses', 1);
  } catch {}
}

async function incrementSubstyleUse(userId) {
  try { if (!userId) return; await userLimitInc(userId, 'substyle', 'uses', 1); } catch {}
}

async function getLimitKV(userId, scope, k) {
  return await userLimitGet(userId, scope, k);
}

async function setLimitKV(userId, scope, k, value) {
  const current = await userLimitGet(userId, scope, k);
  const delta = Number(value) - Number(current || 0);
  if (delta !== 0) await userLimitInc(userId, scope, k, delta);
}

module.exports = {
  checkMonthlyQuota,
  enforceMonthlyLimit,
  allowFreeBatchTrial,
  enforceDeviceLimit,
  enforceSubstyleAndMark,
  prepareMaxModeHeaders,
  countMaxModeUse,
  incrementSubstyleUse,
  getLimitKV,
  setLimitKV,
  getUserFlag,
  setUserFlag
};



// limits.js - Feature gates and quota enforcement
const db = require('./database');
const { TIERS } = require('./auth');

function monthKeyNow() {
  // Returns YYYY-MM for current month in SQLite
  return null; // not used directly in SQL; kept for clarity
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
      const isTeam = tier === 'team';
      return res.status(402).json({
        error: isTeam ? 'Team monthly character limit reached. Contact support to extend.' : 'Monthly character limit reached. Please upgrade.',
        code: 'month_quota_exceeded',
        quota: { used: quota.used, limit: quota.limit, remaining: 0 },
        upgradeMessage: isTeam ? 'Contact sales to extend your Team quota' : 'Upgrade to Pro or Team for higher limits'
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

// Enforce single active device for Free/Pro. Team unlimited.
async function enforceDeviceLimit(req, res, next) {
  try {
    const tier = (req.user?.tier || 'free').toLowerCase();
    if (!req.user?.id) return next(); // guests not enforced
    if (tier === 'team') return next();

    const deviceId = req.headers['x-device-id'];
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 6) {
      return res.status(400).json({ error: 'Missing X-Device-ID header', code: 'device_id_required' });
    }

    const userId = req.user.id;
    // Prune stale devices (10 minutes inactivity window)
    try {
      await db.run(`DELETE FROM active_devices WHERE user_id = ? AND last_seen < DATETIME('now','-10 minutes')`, [userId]);
    } catch {}

    // Is this device already active?
    const current = await db.get('SELECT 1 FROM active_devices WHERE user_id = ? AND device_id = ? LIMIT 1', [userId, deviceId]);
    if (!current) {
      const others = await db.get('SELECT COUNT(*) AS c FROM active_devices WHERE user_id = ?', [userId]);
      if (Number(others?.c || 0) >= 1) {
        return res.status(423).json({
          error: 'Account is active on another device. Please sign out there or wait a few minutes.',
          code: 'too_many_devices',
          help: 'Close the tab on the other device or sign out to switch devices.'
        });
      }
      // Register this device
      try {
        await db.run('INSERT OR REPLACE INTO active_devices (user_id, device_id, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)', [userId, deviceId]);
      } catch {}
    } else {
      // Refresh heartbeat
      try {
        await db.run('UPDATE active_devices SET last_seen = CURRENT_TIMESTAMP WHERE user_id = ? AND device_id = ?', [userId, deviceId]);
      } catch {}
    }

    return next();
  } catch (e) {
    return next();
  }
}

module.exports = {
  checkMonthlyQuota,
  enforceMonthlyLimit,
  allowFreeBatchTrial,
  enforceDeviceLimit,
  getUserFlag,
  setUserFlag
};



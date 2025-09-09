// idempotency.js
const crypto = require('crypto');

const TTL_MS = parseInt(process.env.IDEMPOTENCY_TTL_MS || '600000', 10); // 10 minutes
const HEADER_PATTERN = new RegExp(process.env.IDEMPOTENCY_HEADER_PATTERN || '^idem_[a-z0-9_-]{6,}$', 'i');

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map(k => JSON.stringify(k)+':'+stableStringify(obj[k])).join(',')}}`;
}

function sha256(x) {
  return crypto.createHash('sha256').update(String(x)).digest('hex');
}

class MemoryStore {
  constructor() {
    this.map = new Map(); // key -> { status, body, expiresAt }
    this.timer = setInterval(() => this.gc(), 60_000);
    this.timer.unref?.();
  }
  gc() {
    const now = Date.now();
    for (const [k, v] of this.map.entries()) {
      if (!v || v.expiresAt <= now) this.map.delete(k);
    }
  }
  get(key) { return this.map.get(key); }
  set(key, val) { this.map.set(key, val); }
  clear() { this.map.clear(); }
  size() { return this.map.size; }
  shutdown() { clearInterval(this.timer); this.map.clear(); }
}

const store = new MemoryStore();

/**
 * Build a robust, route-scoped idempotency cache key.
 * Includes: header key + userId + method + path + engine + targetLanguage + body hash
 */
function buildScopedKey(req, headerKey) {
  const userId = req.user?.id ? String(req.user.id) : 'anon';
  const method = String(req.method || 'POST').toUpperCase();
  const path = `${req.baseUrl || ''}${req.path || ''}`;
  const engine = String(req.body?.engine || 'auto');
  const target = String(req.body?.targetLanguage || '');
  // Only body content that affects the result:
  const bodyForHash = {
    ...req.body,
    // Ensure undefined stripped
    engine, target
  };
  const bodyHash = sha256(stableStringify(bodyForHash)).slice(0, 24);
  return `${headerKey}::${userId}::${method}::${path}::${engine}::${target}::${bodyHash}`;
}

/**
 * Express middleware: idempotency with strict scoping
 */
function idempotencyMiddleware(req, res, next) {
  const headerKey = req.get('Idempotency-Key');
  if (!headerKey) return next(); // Only enable if client opted in
  if (!HEADER_PATTERN.test(String(headerKey || ''))) return next(); // Require well-formed key to avoid accidental replays

  const scopedKey = buildScopedKey(req, headerKey);

  // Attempt replay
  const hit = store.get(scopedKey);
  if (hit && hit.expiresAt > Date.now()) {
    res.setHeader('Vary', 'Idempotency-Key');
    res.setHeader('X-Idempotent-Replay', 'true');
    try { res.setHeader('X-Idempotency-Scope', sha256(scopedKey).slice(0, 12)); } catch {}
    res.status(hit.status);
    return res.json(hit.body);
  }

  // Wrap res.json to persist successful responses
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    try {
      // Only store 2xx
      const status = res.statusCode || 200;
      if (status >= 200 && status < 300) {
        store.set(scopedKey, {
          status,
          body: payload,
          expiresAt: Date.now() + TTL_MS
        });
      }
      res.setHeader('Vary', 'Idempotency-Key');
      try { res.setHeader('X-Idempotency-Scope', sha256(scopedKey).slice(0, 12)); } catch {}
    } catch { /* non-fatal */ }
    return originalJson(payload);
  };

  next();
}

class IdempotencyService {
  stats() {
    return { entries: store.size(), ttlMs: TTL_MS };
  }
  reset() { store.clear(); }
  shutdown() { store.shutdown(); }
}

module.exports = {
  IdempotencyService: new IdempotencyService(),
  idempotencyMiddleware
};

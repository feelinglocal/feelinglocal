// redis-rate-limit-store.js - Lightweight Redis store for express-rate-limit v8
const { createClient } = require('redis');

class RedisRateLimitStore {
  constructor(options = {}) {
    const url = options.url || process.env.REDIS_URL;
    if (!url) throw new Error('RedisRateLimitStore requires REDIS_URL or options.url');
    this.windowMs = Number(options.windowMs || 60_000);
    this.prefix = String(options.prefix || 'rate');
    this.client = options.client || createClient({ url, socket: (url.startsWith('rediss://') || process.env.REDIS_TLS === 'true') ? { tls: true, servername: new URL(url).hostname } : {} });
    this.connected = false;
    this.client.on('error', (e) => {
      // Swallow errors; express-rate-limit will still work with best effort
      console.warn('RedisRateLimitStore error:', e?.message || e);
    });
  }

  async init() {
    if (this.connected) return;
    try { await this.client.connect(); this.connected = true; } catch {}
  }

  _key(key) { return `${this.prefix}:${key}`; }

  async increment(key) {
    await this.init();
    const k = this._key(key);
    const hits = await this.client.incr(k);
    // Get remaining TTL in ms (support node-redis and ioredis styles)
    let ttl;
    if (typeof this.client.pTTL === 'function') {
      ttl = await this.client.pTTL(k);
    } else if (typeof this.client.pttl === 'function') {
      ttl = await this.client.pttl(k);
    } else if (typeof this.client.ttl === 'function') {
      const s = await this.client.ttl(k);
      ttl = s > 0 ? s * 1000 : s;
    } else {
      ttl = -1;
    }
    if (ttl < 0) {
      // Set expiration in ms
      if (typeof this.client.pExpire === 'function') {
        await this.client.pExpire(k, this.windowMs);
      } else if (typeof this.client.pexpire === 'function') {
        await this.client.pexpire(k, this.windowMs);
      } else if (typeof this.client.expire === 'function') {
        await this.client.expire(k, Math.ceil(this.windowMs / 1000));
      }
      ttl = this.windowMs;
    }
    return {
      totalHits: hits,
      resetTime: new Date(Date.now() + ttl)
    };
  }

  async decrement(key) {
    await this.init();
    const k = this._key(key);
    try { await this.client.decr(k); } catch {}
  }

  async resetKey(key) {
    await this.init();
    const k = this._key(key);
    try { await this.client.del(k); } catch {}
  }

  shutdown() {
    try { if (this.client?.quit) return this.client.quit(); } catch {}
  }
}

module.exports = { RedisRateLimitStore };



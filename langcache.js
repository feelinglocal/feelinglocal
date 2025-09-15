'use strict';

// Optional Redis LangCache integration wrapper.
// Uses the official SDK: @redis-ai/langcache

let LangCacheSDK;
try {
  LangCacheSDK = require('@redis-ai/langcache');
} catch (e) {
  // SDK not installed – module stays inert. We keep this silent to avoid
  // breaking deployments that don't configure LangCache.
}

class LangCacheWrapper {
  constructor() {
    this.enabled = false;
    this.client = null;
    this.serverURL = process.env.LANGCACHE_SERVER_URL || process.env.LANGCACHE_URL;
    this.cacheId = process.env.LANGCACHE_CACHE_ID || process.env.LANGCACHE_ID;
    this.apiKey = process.env.LANGCACHE_API_KEY;
    this.defaultThreshold = Number(process.env.LANGCACHE_THRESHOLD || 0); // 0 = use service default
  }

  init() {
    if (this.client || this.enabled) return;
    if (!LangCacheSDK) return; // SDK unavailable
    if (!this.serverURL || !this.cacheId || !this.apiKey) return; // not configured
    try {
      // SDK exposes a class named `LangCache`
      const { LangCache } = LangCacheSDK;
      this.client = new LangCache({
        serverURL: this.serverURL,
        cacheId: this.cacheId,
        apiKey: this.apiKey
      });
      this.enabled = true;
    } catch (e) {
      // Keep disabled on any init failure
      this.client = null;
      this.enabled = false;
    }
  }

  isEnabled() {
    if (!this.enabled) this.init();
    return !!this.enabled;
  }

  // Search the LangCache service for a semantically similar entry.
  // Returns the top CacheEntry (or null) as provided by the SDK docs.
  async search(prompt, attributes = {}, { threshold } = {}) {
    try {
      if (!this.isEnabled()) return null;
      const params = { prompt };
      if (attributes && Object.keys(attributes).length) params.attributes = attributes;
      const thr = Number.isFinite(threshold) ? Number(threshold) : this.defaultThreshold;
      if (thr > 0) params.similarityThreshold = thr;
      const res = await this.client.search(params);
      const arr = res && res.data ? res.data : [];
      return Array.isArray(arr) && arr.length ? arr[0] : null;
    } catch (e) {
      // Fail closed – never throw into call sites
      return null;
    }
  }

  // Insert an entry into LangCache (best‑effort)
  async set(prompt, response, attributes = {}) {
    try {
      if (!this.isEnabled()) return false;
      const body = { prompt, response };
      if (attributes && Object.keys(attributes).length) body.attributes = attributes;
      await this.client.set(body);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Delete by attributes (bulk) – mirrors SDK deleteQuery
  async deleteByAttributes(attributes = {}) {
    try {
      if (!this.isEnabled()) return { ok: false, reason: 'disabled' };
      const hasAttrs = attributes && Object.keys(attributes).length > 0;
      const res = await this.client.deleteQuery(hasAttrs ? { attributes } : {});
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // Delete by entry id
  async deleteById(entryId) {
    try {
      if (!this.isEnabled()) return { ok: false, reason: 'disabled' };
      await this.client.deleteById(entryId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}

// Export a singleton instance to share across modules
const langCache = new LangCacheWrapper();

module.exports = { langCache };

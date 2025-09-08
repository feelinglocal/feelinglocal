// translation-cache.js - Redis caching layer for frequent translations
const NodeCache = require('node-cache');
const crypto = require('crypto');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

/**
 * Translation Cache Manager with Redis and memory fallback
 */
class TranslationCacheManager {
  constructor() {
    // Memory cache as fallback
    this.memoryCache = new NodeCache({
      stdTTL: Number(process.env.MEMORY_CACHE_TTL || 3600), // 1 hour
      maxKeys: Number(process.env.MEMORY_CACHE_MAX_KEYS || 10000),
      useClones: false
    });

    // Redis client (from queue.js)
    this.redisClient = null;
    this.isRedisAvailable = false;
    
    // Cache statistics
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      errors: 0,
      memoryHits: 0,
      redisHits: 0
    };

    // Cache configuration
    this.config = {
      defaultTTL: Number(process.env.TRANSLATION_CACHE_TTL || 86400), // 24 hours
      maxKeyLength: Number(process.env.CACHE_MAX_KEY_LENGTH || 250),
      enableTranslationMemory: process.env.TRANSLATION_MEMORY_ENABLED !== 'false',
      enableSemanticMatching: process.env.SEMANTIC_MATCHING_ENABLED === 'true',
      similarityThreshold: Number(process.env.SIMILARITY_THRESHOLD || 0.85)
    };
  }

  /**
   * Initialize cache system
   */
  async init() {
    try {
      // Prefer session/client Redis if REDIS_URL is set
      const { createClient } = require('redis');
      const url = process.env.REDIS_URL;
      if (url) {
        const isTLS = url.startsWith('rediss://') || process.env.REDIS_TLS === 'true';
        this.redisClient = createClient({ url, socket: isTLS ? { tls: true, servername: new URL(url).hostname } : {} });
        this.redisClient.on('error', (e) => log.warn('Translation cache redis error', { error: e?.message||String(e) }));
        try { await this.redisClient.connect(); } catch {}
      } else {
        // Fallback: try queue connection if present
        try {
          const { connection } = require('./queue');
          if (connection) this.redisClient = connection;
        } catch {}
      }
      if (this.redisClient) {
        await this.redisClient.ping();
        this.isRedisAvailable = true;
        log.info('Translation cache initialized with Redis');
      }
    } catch (error) {
      log.warn('Redis not available, using memory cache only', { error: error.message });
      this.isRedisAvailable = false;
    }

    // Set up memory cache event listeners
    this.memoryCache.on('set', (key, value) => {
      log.debug('Memory cache set', { key: this.sanitizeKey(key) });
    });

    this.memoryCache.on('expired', (key, value) => {
      log.debug('Memory cache expired', { key: this.sanitizeKey(key) });
    });

    log.info('Translation cache system initialized', {
      redisAvailable: this.isRedisAvailable,
      memoryCache: true,
      defaultTTL: this.config.defaultTTL
    });
  }

  /**
   * Generate cache key for translation
   */
  generateCacheKey(text, mode, targetLanguage, subStyle = '', injections = '', engine = '') {
    // Create deterministic hash of translation parameters including engine
    const content = [text, mode, targetLanguage, subStyle, injections, engine].join('::');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    
    // Truncate if too long
    const key = `trans:${hash}`;
    return key.length > this.config.maxKeyLength ? 
      key.substring(0, this.config.maxKeyLength) : key;
  }

  /**
   * Generate cache key for batch translation
   */
  generateBatchCacheKey(items, mode, targetLanguage, subStyle = '', injections = '') {
    const content = [items.join('||'), mode, targetLanguage, subStyle, injections].join('::');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `batch:${hash}`;
  }

  /**
   * Get translation from cache
   */
  async getTranslation(text, mode, targetLanguage, subStyle = '', injections = '', engine = '') {
    try {
      const key = this.generateCacheKey(text, mode, targetLanguage, subStyle, injections, engine);
      
      // Try Redis first
      if (this.isRedisAvailable) {
        try {
          const redisResult = await this.redisClient.get(key);
          if (redisResult) {
            this.stats.hits++;
            this.stats.redisHits++;
            recordMetrics.circuitBreakerSuccess('cache:redis:hit');
            
            log.debug('Translation cache hit (Redis)', { 
              key: this.sanitizeKey(key),
              textLength: text.length 
            });
            
            return JSON.parse(redisResult);
          }
        } catch (redisError) {
          log.warn('Redis cache error', { error: redisError.message });
          this.stats.errors++;
        }
      }

      // Try memory cache as fallback
      const memoryResult = this.memoryCache.get(key);
      if (memoryResult) {
        this.stats.hits++;
        this.stats.memoryHits++;
        recordMetrics.circuitBreakerSuccess('cache:memory:hit');
        
        log.debug('Translation cache hit (Memory)', { 
          key: this.sanitizeKey(key),
          textLength: text.length 
        });
        
        return memoryResult;
      }

      // Cache miss
      this.stats.misses++;
      recordMetrics.circuitBreakerFailure('cache:miss');
      
      log.debug('Translation cache miss', { 
        key: this.sanitizeKey(key),
        textLength: text.length 
      });
      
      return null;
    } catch (error) {
      this.stats.errors++;
      log.error('Cache get error', { error: error.message });
      return null;
    }
  }

  /**
   * Delete translation from cache
   */
  async deleteTranslation(text, mode, targetLanguage, subStyle = '', injections = '', engine = '') {
    try {
      const key = this.generateCacheKey(text, mode, targetLanguage, subStyle, injections, engine);
      
      let deleted = false;
      
      // Delete from Redis
      if (this.isRedisAvailable) {
        try {
          const redisDeleted = await this.redisClient.del(key);
          if (redisDeleted > 0) deleted = true;
        } catch (redisError) {
          log.warn('Redis cache delete error', { error: redisError.message });
        }
      }

      // Delete from memory cache
      const memoryDeleted = this.memoryCache.del(key);
      if (memoryDeleted) deleted = true;
      
      log.debug('Translation cache delete', { 
        key: this.sanitizeKey(key),
        deleted 
      });
      
      return deleted;
    } catch (error) {
      log.error('Cache delete error', { error: error.message });
      return false;
    }
  }

  /**
   * Store translation in cache
   */
  async setTranslation(text, mode, targetLanguage, result, subStyle = '', injections = '', ttl = null, engine = '') {
    try {
      const key = this.generateCacheKey(text, mode, targetLanguage, subStyle, injections, engine);
      const cacheData = {
        text,
        mode,
        targetLanguage,
        subStyle,
        injections,
        result,
        timestamp: Date.now(),
        hits: 0
      };

      const cacheTTL = ttl || this.config.defaultTTL;

      // Store in Redis
      if (this.isRedisAvailable) {
        try {
          const payload = JSON.stringify(cacheData);
          if (typeof this.redisClient.setEx === 'function') {
            await this.redisClient.setEx(key, cacheTTL, payload);
          } else if (typeof this.redisClient.set === 'function') {
            try {
              // node-redis v4 style
              await this.redisClient.set(key, payload, { EX: cacheTTL });
            } catch (e) {
              // ioredis style fallback
              await this.redisClient.set(key, payload, 'EX', cacheTTL);
            }
          } else {
            throw new Error('Unsupported Redis client: missing set/setEx');
          }
          log.debug('Translation cached in Redis', { 
            key: this.sanitizeKey(key),
            ttl: cacheTTL 
          });
        } catch (redisError) {
          log.warn('Redis cache set error', { error: redisError.message });
        }
      }

      // Store in memory cache
      this.memoryCache.set(key, cacheData, cacheTTL);
      
      this.stats.sets++;
      recordMetrics.circuitBreakerSuccess('cache:set');
      
      log.debug('Translation cached', { 
        key: this.sanitizeKey(key),
        textLength: text.length,
        resultLength: result.length
      });
      
    } catch (error) {
      this.stats.errors++;
      log.error('Cache set error', { error: error.message });
    }
  }

  /**
   * Get batch translation from cache
   */
  async getBatchTranslation(items, mode, targetLanguage, subStyle = '', injections = '') {
    try {
      const key = this.generateBatchCacheKey(items, mode, targetLanguage, subStyle, injections);
      
      // Try Redis first
      if (this.isRedisAvailable) {
        try {
          const result = await this.redisClient.get(key);
          if (result) {
            this.stats.hits++;
            this.stats.redisHits++;
            return JSON.parse(result);
          }
        } catch (redisError) {
          log.warn('Redis batch cache error', { error: redisError.message });
        }
      }

      // Try memory cache
      const memoryResult = this.memoryCache.get(key);
      if (memoryResult) {
        this.stats.hits++;
        this.stats.memoryHits++;
        return memoryResult;
      }

      this.stats.misses++;
      return null;
    } catch (error) {
      this.stats.errors++;
      log.error('Batch cache get error', { error: error.message });
      return null;
    }
  }

  /**
   * Store batch translation in cache
   */
  async setBatchTranslation(items, mode, targetLanguage, results, subStyle = '', injections = '', ttl = null) {
    try {
      const key = this.generateBatchCacheKey(items, mode, targetLanguage, subStyle, injections);
      const cacheData = {
        items,
        mode,
        targetLanguage,
        subStyle,
        injections,
        results,
        timestamp: Date.now()
      };

      const cacheTTL = ttl || this.config.defaultTTL;

      // Store in Redis
      if (this.isRedisAvailable) {
        try {
          const payload = JSON.stringify(cacheData);
          if (typeof this.redisClient.setEx === 'function') {
            await this.redisClient.setEx(key, cacheTTL, payload);
          } else if (typeof this.redisClient.set === 'function') {
            try {
              await this.redisClient.set(key, payload, { EX: cacheTTL });
            } catch (e) {
              await this.redisClient.set(key, payload, 'EX', cacheTTL);
            }
          } else {
            throw new Error('Unsupported Redis client: missing set/setEx');
          }
        } catch (redisError) {
          log.warn('Redis batch cache set error', { error: redisError.message });
        }
      }

      // Store in memory cache
      this.memoryCache.set(key, cacheData, cacheTTL);
      this.stats.sets++;
      
    } catch (error) {
      this.stats.errors++;
      log.error('Batch cache set error', { error: error.message });
    }
  }

  /**
   * Find similar translations using fuzzy matching
   */
  async findSimilarTranslations(text, mode, targetLanguage, limit = 5) {
    if (!this.config.enableSemanticMatching) {
      return [];
    }

    try {
      // Get all cache keys (this is expensive, consider implementing differently in production)
      const pattern = `trans:*`;
      let keys = [];

      if (this.isRedisAvailable) {
        try {
          keys = await this.redisClient.keys(pattern);
        } catch (redisError) {
          log.warn('Redis keys scan error', { error: redisError.message });
        }
      }

      // Add memory cache keys
      const memoryKeys = this.memoryCache.keys().filter(k => k.startsWith('trans:'));
      keys = [...new Set([...keys, ...memoryKeys])];

      const similarities = [];
      
      for (const key of keys.slice(0, 100)) { // Limit search for performance
        try {
          let cacheData = null;
          
          // Try Redis first
          if (this.isRedisAvailable) {
            const redisData = await this.redisClient.get(key);
            if (redisData) {
              cacheData = JSON.parse(redisData);
            }
          }
          
          // Fallback to memory cache
          if (!cacheData) {
            cacheData = this.memoryCache.get(key);
          }

          if (cacheData && 
              cacheData.mode === mode && 
              cacheData.targetLanguage === targetLanguage) {
            
            const similarity = this.calculateSimilarity(text, cacheData.text);
            
            if (similarity >= this.config.similarityThreshold) {
              similarities.push({
                key,
                similarity,
                original: cacheData.text,
                translation: cacheData.result,
                timestamp: cacheData.timestamp
              });
            }
          }
        } catch (error) {
          log.debug('Error processing cache key for similarity', { key, error: error.message });
        }
      }

      // Sort by similarity and return top matches
      return similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
        
    } catch (error) {
      log.error('Similar translations search failed', { error: error.message });
      return [];
    }
  }

  /**
   * Calculate text similarity (simple Levenshtein-based approach)
   */
  calculateSimilarity(text1, text2) {
    if (text1 === text2) return 1.0;
    
    const len1 = text1.length;
    const len2 = text2.length;
    
    if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
    if (len2 === 0) return 0.0;
    
    // Simple similarity based on common words
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Invalidate cache for specific parameters
   */
  async invalidateCache(pattern) {
    try {
      // Invalidate Redis cache
      if (this.isRedisAvailable) {
        const keys = await this.redisClient.keys(pattern);
        if (keys.length > 0) {
          await this.redisClient.del(...keys);
          log.info('Redis cache invalidated', { pattern, keys: keys.length });
        }
      }

      // Invalidate memory cache
      const memoryKeys = this.memoryCache.keys();
      const matchingKeys = memoryKeys.filter(key => 
        key.includes(pattern.replace('*', ''))
      );
      
      for (const key of matchingKeys) {
        this.memoryCache.del(key);
      }

      log.info('Cache invalidated', { pattern, memoryKeys: matchingKeys.length });
      
    } catch (error) {
      log.error('Cache invalidation failed', { pattern, error: error.message });
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const memoryStats = this.memoryCache.getStats();
    
    return {
      ...this.stats,
      hitRate: this.stats.hits + this.stats.misses > 0 ? 
        (this.stats.hits / (this.stats.hits + this.stats.misses)) : 0,
      memory: {
        keys: memoryStats.keys,
        hits: memoryStats.hits,
        misses: memoryStats.misses,
        ksize: memoryStats.ksize,
        vsize: memoryStats.vsize
      },
      redis: {
        available: this.isRedisAvailable,
        hits: this.stats.redisHits
      }
    };
  }

  /**
   * Warm up cache with common translations
   */
  async warmUpCache() {
    try {
      const commonTranslations = [
        { text: 'Hello', mode: 'formal', targetLanguage: 'French' },
        { text: 'Thank you', mode: 'formal', targetLanguage: 'Spanish' },
        { text: 'Welcome', mode: 'casual', targetLanguage: 'German' },
        { text: 'Good morning', mode: 'formal', targetLanguage: 'Italian' },
        { text: 'Please', mode: 'formal', targetLanguage: 'Portuguese' }
      ];

      // These would be pre-computed translations
      const precomputedResults = {
        'Hello::formal::French': 'Bonjour',
        'Thank you::formal::Spanish': 'Gracias',
        'Welcome::casual::German': 'Willkommen',
        'Good morning::formal::Italian': 'Buongiorno',
        'Please::formal::Portuguese': 'Por favor'
      };

      for (const translation of commonTranslations) {
        const resultKey = `${translation.text}::${translation.mode}::${translation.targetLanguage}`;
        const result = precomputedResults[resultKey];
        
        if (result) {
          await this.setTranslation(
            translation.text,
            translation.mode,
            translation.targetLanguage,
            result,
            '',
            '',
            this.config.defaultTTL * 2 // Longer TTL for common translations
          );
        }
      }

      log.info('Cache warmed up with common translations', { 
        count: commonTranslations.length 
      });
      
    } catch (error) {
      log.error('Cache warm-up failed', { error: error.message });
    }
  }

  /**
   * Clean up expired entries
   */
  async cleanup() {
    try {
      // Memory cache handles its own cleanup
      const beforeKeys = this.memoryCache.getStats().keys;
      
      // Force cleanup of expired keys
      this.memoryCache.flushStats();
      
      const afterKeys = this.memoryCache.getStats().keys;
      const cleaned = beforeKeys - afterKeys;
      
      if (cleaned > 0) {
        log.info('Cache cleanup completed', { cleanedKeys: cleaned });
      }
      
    } catch (error) {
      log.error('Cache cleanup failed', { error: error.message });
    }
  }

  /**
   * Sanitize key for logging (remove sensitive content)
   */
  sanitizeKey(key) {
    return key.length > 50 ? key.substring(0, 50) + '...' : key;
  }

  /**
   * Health check for cache system
   */
  healthCheck() {
    const stats = this.getStats();
    const memoryStats = this.memoryCache.getStats();
    
    return {
      status: 'healthy',
      redis: {
        available: this.isRedisAvailable,
        hits: this.stats.redisHits
      },
      memory: {
        keys: memoryStats.keys,
        hits: memoryStats.hits,
        misses: memoryStats.misses
      },
      performance: {
        hitRate: Math.round(stats.hitRate * 100) / 100,
        totalOperations: this.stats.hits + this.stats.misses
      },
      config: {
        defaultTTL: this.config.defaultTTL,
        translationMemoryEnabled: this.config.enableTranslationMemory,
        semanticMatchingEnabled: this.config.enableSemanticMatching
      }
    };
  }
}

// Global cache manager instance
const translationCache = new TranslationCacheManager();

/**
 * Middleware to add caching capabilities to translation requests
 */
function cacheMiddleware(req, res, next) {
  req.cache = {
    get: (text, mode, targetLanguage, subStyle, injections, engine) => 
      translationCache.getTranslation(text, mode, targetLanguage, subStyle, injections, engine),
    set: (text, mode, targetLanguage, result, subStyle, injections, ttl, engine) => 
      translationCache.setTranslation(text, mode, targetLanguage, result, subStyle, injections, ttl, engine),
    delete: (text, mode, targetLanguage, subStyle, injections, engine) => 
      translationCache.deleteTranslation(text, mode, targetLanguage, subStyle, injections, engine),
    getBatch: (items, mode, targetLanguage, subStyle, injections) => 
      translationCache.getBatchTranslation(items, mode, targetLanguage, subStyle, injections),
    setBatch: (items, mode, targetLanguage, results, subStyle, injections, ttl) => 
      translationCache.setBatchTranslation(items, mode, targetLanguage, results, subStyle, injections, ttl),
    findSimilar: (text, mode, targetLanguage, limit) => 
      translationCache.findSimilarTranslations(text, mode, targetLanguage, limit),
    invalidate: (pattern) => translationCache.invalidateCache(pattern),
    getStats: () => translationCache.getStats(),
    healthCheck: () => translationCache.healthCheck()
  };
  next();
}

/**
 * Cache-aware translation wrapper
 */
async function cacheAwareTranslation(translationFunction, cacheParams, translationParams) {
  const { text, mode, targetLanguage, subStyle = '', injections = '', engine = '' } = cacheParams;
  
  // Check cache first
  const cached = await translationCache.getTranslation(text, mode, targetLanguage, subStyle, injections, engine);
  if (cached) {
    // Update hit count
    cached.hits = (cached.hits || 0) + 1;
    return cached.result;
  }

  // Execute translation
  const result = await translationFunction(translationParams);
  
  // Cache the result
  await translationCache.setTranslation(text, mode, targetLanguage, result, subStyle, injections, null, engine);
  
  return result;
}

/**
 * Initialize cache system
 */
async function initTranslationCache() {
  await translationCache.init();
  
  // Warm up cache with common translations
  await translationCache.warmUpCache();
  
  // Schedule periodic cleanup
  setInterval(() => {
    translationCache.cleanup();
  }, 3600000); // Every hour
  
  return translationCache;
}

module.exports = {
  TranslationCacheManager,
  translationCache,
  cacheMiddleware,
  cacheAwareTranslation,
  initTranslationCache
};



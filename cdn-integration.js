// cdn-integration.js - CDN integration for global performance
const log = require('./logger');
const { recordMetrics } = require('./metrics');

/**
 * CDN Integration Manager
 */
class CDNManager {
  constructor() {
    this.config = {
      enabled: process.env.CDN_ENABLED === 'true',
      provider: process.env.CDN_PROVIDER || 'cloudflare', // cloudflare, aws, azure, gcp
      baseUrl: process.env.CDN_BASE_URL || '',
      apiKey: process.env.CDN_API_KEY || '',
      zoneId: process.env.CDN_ZONE_ID || '',
      cacheRules: {
        static: { maxAge: 31536000 }, // 1 year for static assets
        api: { maxAge: 300 }, // 5 minutes for API responses
        translations: { maxAge: 3600 }, // 1 hour for translations
        files: { maxAge: 86400 } // 1 day for uploaded files
      }
    };

    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      purgeRequests: 0,
      uploadedAssets: 0
    };
  }

  /**
   * Initialize CDN integration
   */
  async init() {
    if (!this.config.enabled) {
      log.info('CDN integration disabled');
      return;
    }

    try {
      // Validate CDN configuration
      await this.validateConfiguration();
      
      // Set up CDN provider client
      await this.initializeProvider();
      
      log.info('CDN integration initialized', {
        provider: this.config.provider,
        baseUrl: this.config.baseUrl
      });
    } catch (error) {
      log.error('CDN initialization failed', { error: error.message });
      // Don't throw - continue without CDN
    }
  }

  /**
   * Validate CDN configuration
   */
  async validateConfiguration() {
    if (!this.config.baseUrl) {
      throw new Error('CDN_BASE_URL is required');
    }

    if (!this.config.apiKey && this.config.provider !== 'generic') {
      log.warn('CDN API key not provided - some features may not work');
    }
  }

  /**
   * Initialize CDN provider client
   */
  async initializeProvider() {
    switch (this.config.provider) {
      case 'cloudflare':
        this.client = await this.initializeCloudflare();
        break;
      case 'aws':
        this.client = await this.initializeAWS();
        break;
      case 'azure':
        this.client = await this.initializeAzure();
        break;
      case 'gcp':
        this.client = await this.initializeGCP();
        break;
      default:
        this.client = null; // Generic CDN without API
    }
  }

  /**
   * Initialize Cloudflare CDN client
   */
  async initializeCloudflare() {
    if (!this.config.apiKey) return null;

    return {
      purgeCache: async (urls) => {
        const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/purge_cache`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ files: urls })
        });
        
        return response.json();
      },
      
      getCacheStats: async () => {
        const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/analytics/dashboard`, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`
          }
        });
        
        return response.json();
      }
    };
  }

  /**
   * Initialize AWS CloudFront client
   */
  async initializeAWS() {
    // AWS CloudFront integration would go here
    return null;
  }

  /**
   * Initialize Azure CDN client
   */
  async initializeAzure() {
    // Azure CDN integration would go here
    return null;
  }

  /**
   * Initialize Google Cloud CDN client
   */
  async initializeGCP() {
    // Google Cloud CDN integration would go here
    return null;
  }

  /**
   * Get CDN URL for asset
   */
  getCDNUrl(assetPath) {
    if (!this.config.enabled || !this.config.baseUrl) {
      return assetPath; // Return original path if CDN not available
    }

    // Ensure path starts with /
    const normalizedPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
    
    return `${this.config.baseUrl}${normalizedPath}`;
  }

  /**
   * Purge cache for specific URLs
   */
  async purgeCache(urls) {
    if (!this.config.enabled || !this.client) {
      return { success: false, reason: 'CDN not configured' };
    }

    try {
      const result = await this.client.purgeCache(urls);
      this.stats.purgeRequests++;
      
      log.info('CDN cache purged', { urls: urls.length, result });
      recordMetrics.circuitBreakerSuccess('cdn:purge');
      
      return { success: true, result };
    } catch (error) {
      log.error('CDN cache purge failed', { urls, error: error.message });
      recordMetrics.circuitBreakerFailure('cdn:purge');
      return { success: false, error: error.message };
    }
  }

  /**
   * Set cache headers for response
   */
  setCacheHeaders(res, cacheType = 'api') {
    const cacheRule = this.config.cacheRules[cacheType] || this.config.cacheRules.api;
    
    if (this.config.enabled) {
      res.set({
        'Cache-Control': `public, max-age=${cacheRule.maxAge}`,
        'CDN-Cache-Control': `public, max-age=${cacheRule.maxAge}`,
        'Vary': 'Accept-Encoding, Authorization',
        'X-CDN-Provider': this.config.provider
      });
    } else {
      // Default caching for non-CDN
      res.set({
        'Cache-Control': `public, max-age=${Math.min(cacheRule.maxAge, 300)}` // Max 5 minutes without CDN
      });
    }
  }

  /**
   * Preload critical assets to CDN
   */
  async preloadAssets() {
    if (!this.config.enabled) return;

    const criticalAssets = [
      '/public/index.html',
      '/public/localization-client.js',
      '/api/health',
      '/auth/sso/providers'
    ];

    try {
      for (const asset of criticalAssets) {
        const cdnUrl = this.getCDNUrl(asset);
        
        // Warm up CDN cache by making a request
        try {
          await fetch(cdnUrl, { method: 'HEAD' });
          this.stats.uploadedAssets++;
        } catch (fetchError) {
          log.debug('Asset preload failed', { asset, error: fetchError.message });
        }
      }

      log.info('CDN assets preloaded', { count: criticalAssets.length });
    } catch (error) {
      log.error('Asset preloading failed', { error: error.message });
    }
  }

  /**
   * Get CDN statistics
   */
  async getCDNStatistics() {
    const stats = {
      enabled: this.config.enabled,
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      stats: this.stats
    };

    if (this.client && this.client.getCacheStats) {
      try {
        const providerStats = await this.client.getCacheStats();
        stats.provider_stats = providerStats;
      } catch (error) {
        log.debug('Failed to get provider stats', { error: error.message });
      }
    }

    return stats;
  }

  /**
   * Health check for CDN system
   */
  async healthCheck() {
    if (!this.config.enabled) {
      return { status: 'disabled' };
    }

    try {
      // Test CDN connectivity
      const testUrl = this.getCDNUrl('/api/health');
      const response = await fetch(testUrl, { 
        method: 'HEAD',
        timeout: 10000 
      });

      const isHealthy = response.ok;
      
      return {
        status: isHealthy ? 'healthy' : 'unhealthy',
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        responseStatus: response.status,
        stats: this.stats
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        provider: this.config.provider
      };
    }
  }
}

// Global CDN manager instance
const cdnManager = new CDNManager();

/**
 * Middleware to add CDN capabilities and headers
 */
function cdnMiddleware(req, res, next) {
  // Add CDN utilities to request
  req.cdn = {
    getUrl: (path) => cdnManager.getCDNUrl(path),
    purgeCache: (urls) => cdnManager.purgeCache(urls),
    getStats: () => cdnManager.getCDNStatistics(),
    healthCheck: () => cdnManager.healthCheck()
  };

  // Never cache non-GET requests to avoid stale/carry-over results
  if (req.method !== 'GET') {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    return next();
  }

  // Add cache control headers based on route
  let cacheType = 'api';
  
  if (req.path.startsWith('/public/') || req.path.match(/\.(js|css|png|jpg|svg|ico)$/)) {
    cacheType = 'static';
  } else if (req.path.startsWith('/api/translate')) {
    cacheType = 'translations';
  } else if (req.path.startsWith('/uploads/')) {
    cacheType = 'files';
  }

  // Set cache headers
  cdnManager.setCacheHeaders(res, cacheType);

  next();
}

/**
 * Initialize CDN system
 */
async function initCDN() {
  await cdnManager.init();
  
  // Preload critical assets
  setTimeout(() => {
    cdnManager.preloadAssets();
  }, 5000); // Delay to ensure server is ready
  
  return cdnManager;
}

module.exports = {
  CDNManager,
  cdnManager,
  cdnMiddleware,
  initCDN
};



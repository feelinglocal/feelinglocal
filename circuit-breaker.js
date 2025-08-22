// circuit-breaker.js - Circuit Breaker Pattern for Resilient OpenAI API Calls
const CircuitBreaker = require('opossum');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

// Circuit breaker configurations for different service types
const CIRCUIT_CONFIGS = {
  openai: {
    timeout: Number(process.env.OPENAI_TIMEOUT || 30000), // 30 seconds
    errorThresholdPercentage: Number(process.env.OPENAI_ERROR_THRESHOLD || 50), // 50% error rate
    resetTimeout: Number(process.env.OPENAI_RESET_TIMEOUT || 60000), // 1 minute
    volumeThreshold: Number(process.env.OPENAI_VOLUME_THRESHOLD || 10), // Min 10 calls
    capacity: Number(process.env.OPENAI_CAPACITY || 100), // Max 100 concurrent calls
    rollingCountTimeout: Number(process.env.OPENAI_ROLLING_TIMEOUT || 10000), // 10 second window
    rollingCountBuckets: Number(process.env.OPENAI_ROLLING_BUCKETS || 10), // 10 buckets
    enabled: process.env.OPENAI_CIRCUIT_BREAKER_ENABLED !== 'false', // Default enabled
    fallbackFunction: (error, ...args) => {
      log.warn('OpenAI circuit breaker fallback triggered', { error: error.message });
      return { error: 'Service temporarily unavailable. Please try again later.', fallback: true };
    }
  },
  external: {
    timeout: Number(process.env.EXTERNAL_TIMEOUT || 10000), // 10 seconds
    errorThresholdPercentage: Number(process.env.EXTERNAL_ERROR_THRESHOLD || 60), // 60% error rate
    resetTimeout: Number(process.env.EXTERNAL_RESET_TIMEOUT || 30000), // 30 seconds
    volumeThreshold: Number(process.env.EXTERNAL_VOLUME_THRESHOLD || 5), // Min 5 calls
    capacity: Number(process.env.EXTERNAL_CAPACITY || 50), // Max 50 concurrent calls
    rollingCountTimeout: Number(process.env.EXTERNAL_ROLLING_TIMEOUT || 5000), // 5 second window
    rollingCountBuckets: Number(process.env.EXTERNAL_ROLLING_BUCKETS || 5), // 5 buckets
    enabled: process.env.EXTERNAL_CIRCUIT_BREAKER_ENABLED !== 'false', // Default enabled
    fallbackFunction: (error, ...args) => {
      log.warn('External service circuit breaker fallback triggered', { error: error.message });
      return { error: 'External service temporarily unavailable.', fallback: true };
    }
  }
};

class CircuitBreakerService {
  constructor() {
    this.breakers = new Map();
    this.stats = new Map();
  }

  /**
   * Create or get a circuit breaker for a specific service
   */
  getBreaker(serviceName, asyncFunction, options = {}) {
    const key = `${serviceName}:${asyncFunction.name || 'anonymous'}`;
    
    if (this.breakers.has(key)) {
      return this.breakers.get(key);
    }

    const config = CIRCUIT_CONFIGS[serviceName] || CIRCUIT_CONFIGS.external;
    const breakerOptions = {
      ...config,
      ...options,
      name: key
    };

    // Remove fallbackFunction from options and set it separately
    const { fallbackFunction, ...optsWithoutFallback } = breakerOptions;
    
    const breaker = new CircuitBreaker(asyncFunction, optsWithoutFallback);

    // Set fallback if provided
    if (fallbackFunction) {
      breaker.fallback(fallbackFunction);
    }

    // Set up event listeners
    this.setupBreakerEvents(key, breaker);

    this.breakers.set(key, breaker);
    this.stats.set(key, {
      created: Date.now(),
      lastStateChange: Date.now(),
      totalCalls: 0
    });

    log.info('Circuit breaker created', { 
      serviceName, 
      key, 
      timeout: breakerOptions.timeout,
      errorThreshold: breakerOptions.errorThresholdPercentage
    });

    return breaker;
  }

  /**
   * Set up event listeners for circuit breaker
   */
  setupBreakerEvents(key, breaker) {
    const stats = this.stats.get(key) || {};

    breaker.on('fire', () => {
      stats.totalCalls = (stats.totalCalls || 0) + 1;
      recordMetrics.circuitBreakerFire(key);
    });

    breaker.on('success', (result) => {
      log.debug('Circuit breaker success', { key });
      recordMetrics.circuitBreakerSuccess(key);
    });

    breaker.on('failure', (error) => {
      log.warn('Circuit breaker failure', { key, error: error.message });
      recordMetrics.circuitBreakerFailure(key);
    });

    breaker.on('timeout', () => {
      log.warn('Circuit breaker timeout', { key });
      recordMetrics.circuitBreakerTimeout(key);
    });

    breaker.on('reject', () => {
      log.warn('Circuit breaker reject', { key });
      recordMetrics.circuitBreakerReject(key);
    });

    breaker.on('open', () => {
      log.error('Circuit breaker opened', { key });
      stats.lastStateChange = Date.now();
      recordMetrics.circuitBreakerStateChange(key, 'open');
    });

    breaker.on('halfOpen', () => {
      log.info('Circuit breaker half-open', { key });
      stats.lastStateChange = Date.now();
      recordMetrics.circuitBreakerStateChange(key, 'halfOpen');
    });

    breaker.on('close', () => {
      log.info('Circuit breaker closed', { key });
      stats.lastStateChange = Date.now();
      recordMetrics.circuitBreakerStateChange(key, 'closed');
    });

    breaker.on('fallback', (result) => {
      log.warn('Circuit breaker fallback executed', { key, result });
      recordMetrics.circuitBreakerFallback(key);
    });

    breaker.on('semaphoreLocked', () => {
      log.warn('Circuit breaker semaphore locked', { key });
      recordMetrics.circuitBreakerSemaphoreLocked(key);
    });
  }

  /**
   * Get statistics for all circuit breakers
   */
  getStats() {
    const allStats = {};
    
    for (const [key, breaker] of this.breakers.entries()) {
      const breakerStats = breaker.stats;
      const internalStats = this.stats.get(key) || {};
      
      allStats[key] = {
        state: {
          enabled: breaker.enabled,
          closed: breaker.closed,
          open: breaker.open,
          halfOpen: breaker.halfOpen,
          name: breaker.name
        },
        stats: {
          fires: breakerStats.fires,
          failures: breakerStats.failures,
          successes: breakerStats.successes,
          rejects: breakerStats.rejects,
          timeouts: breakerStats.timeouts,
          fallbacks: breakerStats.fallbacks,
          semaphoreRejections: breakerStats.semaphoreRejections,
          latencyMean: breakerStats.latencyMean,
          percentiles: breakerStats.percentiles
        },
        internal: internalStats,
        config: {
          timeout: breaker.options.timeout,
          errorThresholdPercentage: breaker.options.errorThresholdPercentage,
          resetTimeout: breaker.options.resetTimeout,
          volumeThreshold: breaker.options.volumeThreshold,
          capacity: breaker.options.capacity
        }
      };
    }

    return allStats;
  }

  /**
   * Reset a specific circuit breaker
   */
  resetBreaker(serviceName, functionName) {
    const key = `${serviceName}:${functionName}`;
    const breaker = this.breakers.get(key);
    
    if (breaker) {
      breaker.close();
      breaker.clearCache();
      log.info('Circuit breaker reset', { key });
      return true;
    }
    
    return false;
  }

  /**
   * Health check for circuit breakers
   */
  healthCheck() {
    const health = {
      status: 'healthy',
      breakers: {},
      summary: {
        total: this.breakers.size,
        open: 0,
        halfOpen: 0,
        closed: 0
      }
    };

    for (const [key, breaker] of this.breakers.entries()) {
      const state = breaker.opened ? 'open' : (breaker.halfOpen ? 'halfOpen' : 'closed');
      health.breakers[key] = {
        state,
        enabled: breaker.enabled,
        stats: {
          fires: breaker.stats.fires,
          failures: breaker.stats.failures,
          successes: breaker.stats.successes,
          rejects: breaker.stats.rejects
        }
      };

      health.summary[state]++;
    }

    // Mark as unhealthy if any breaker is open
    if (health.summary.open > 0) {
      health.status = 'degraded';
    }

    return health;
  }

  /**
   * Gracefully shutdown all circuit breakers
   */
  async shutdown() {
    log.info('Shutting down circuit breakers...');
    
    for (const [key, breaker] of this.breakers.entries()) {
      try {
        if (breaker.shutdown) {
          await breaker.shutdown();
        }
        log.debug('Circuit breaker shutdown', { key });
      } catch (error) {
        log.error('Error shutting down circuit breaker', { key, error: error.message });
      }
    }

    this.breakers.clear();
    this.stats.clear();
    log.info('Circuit breakers shutdown completed');
  }
}

// Global circuit breaker service instance
const circuitBreakerService = new CircuitBreakerService();

/**
 * Wrap OpenAI API calls with circuit breaker
 */
function wrapOpenAICall(openaiFunction, options = {}) {
  return circuitBreakerService.getBreaker('openai', openaiFunction, options);
}

/**
 * Wrap external API calls with circuit breaker
 */
function wrapExternalCall(externalFunction, options = {}) {
  return circuitBreakerService.getBreaker('external', externalFunction, options);
}

/**
 * Middleware to add circuit breaker to request context
 */
function circuitBreakerMiddleware(req, res, next) {
  req.circuitBreaker = {
    wrapOpenAI: (fn, opts) => wrapOpenAICall(fn, opts),
    wrapExternal: (fn, opts) => wrapExternalCall(fn, opts),
    getStats: () => circuitBreakerService.getStats(),
    healthCheck: () => circuitBreakerService.healthCheck()
  };
  next();
}

module.exports = {
  CircuitBreakerService,
  circuitBreakerService,
  wrapOpenAICall,
  wrapExternalCall,
  circuitBreakerMiddleware
};

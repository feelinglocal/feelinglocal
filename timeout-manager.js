// timeout-manager.js - Enhanced timeout management for different operations
const log = require('./logger');
const { recordMetrics } = require('./metrics');

/**
 * Timeout configurations for different operation types
 */
const TIMEOUT_CONFIGS = {
  // OpenAI API calls
  openai: {
    single: Number(process.env.OPENAI_SINGLE_TIMEOUT || 30000), // 30 seconds
    batch: Number(process.env.OPENAI_BATCH_TIMEOUT || 120000), // 2 minutes
    long: Number(process.env.OPENAI_LONG_TIMEOUT || 300000), // 5 minutes
    streaming: Number(process.env.OPENAI_STREAMING_TIMEOUT || 60000) // 1 minute
  },
  
  // File operations
  file: {
    upload: Number(process.env.FILE_UPLOAD_TIMEOUT || 60000), // 1 minute
    processing: Number(process.env.FILE_PROCESSING_TIMEOUT || 300000), // 5 minutes
    download: Number(process.env.FILE_DOWNLOAD_TIMEOUT || 60000) // 1 minute
  },
  
  // Database operations
  database: {
    query: Number(process.env.DB_QUERY_TIMEOUT || 10000), // 10 seconds
    transaction: Number(process.env.DB_TRANSACTION_TIMEOUT || 30000), // 30 seconds
    migration: Number(process.env.DB_MIGRATION_TIMEOUT || 300000) // 5 minutes
  },
  
  // External API calls
  external: {
    standard: Number(process.env.EXTERNAL_API_TIMEOUT || 10000), // 10 seconds
    slow: Number(process.env.EXTERNAL_API_SLOW_TIMEOUT || 30000) // 30 seconds
  },

  // Queue operations
  queue: {
    jobProcessing: Number(process.env.QUEUE_JOB_TIMEOUT || 600000), // 10 minutes
    cleanup: Number(process.env.QUEUE_CLEANUP_TIMEOUT || 60000) // 1 minute
  }
};

/**
 * Enhanced timeout wrapper with configurable behavior
 */
class TimeoutManager {
  constructor() {
    this.activeTimeouts = new Map();
    this.stats = {
      created: 0,
      completed: 0,
      timedOut: 0,
      cancelled: 0
    };
  }

  /**
   * Create a timeout-controlled promise
   */
  async withTimeout(
    promise, 
    timeoutMs, 
    options = {}
  ) {
    const {
      timeoutMessage = 'Operation timed out',
      onTimeout = null,
      abortController = null,
      trackingKey = null
    } = options;

    const timeoutId = Symbol('timeout');
    const startTime = Date.now();
    
    this.stats.created++;
    
    if (trackingKey) {
      this.activeTimeouts.set(trackingKey, {
        startTime,
        timeoutMs,
        timeoutId
      });
    }

    let timeoutHandle;
    let completed = false;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(async () => {
        if (!completed) {
          completed = true;
          this.stats.timedOut++;
          
          // Abort the operation if AbortController is provided
          if (abortController && !abortController.signal.aborted) {
            abortController.abort();
          }
          
          // Call timeout callback if provided
          if (onTimeout && typeof onTimeout === 'function') {
            try {
              await onTimeout();
            } catch (callbackError) {
              log.error('Timeout callback error', { error: callbackError.message });
            }
          }
          
          const duration = Date.now() - startTime;
          log.warn('Operation timed out', { 
            duration, 
            timeoutMs, 
            timeoutMessage,
            trackingKey 
          });
          
          // Record timeout metric
          if (trackingKey) {
            recordMetrics.circuitBreakerTimeout(trackingKey);
          }
          
          reject(new TimeoutError(timeoutMessage, timeoutMs, duration));
        }
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      
      if (!completed) {
        completed = true;
        clearTimeout(timeoutHandle);
        this.stats.completed++;
        
        if (trackingKey) {
          this.activeTimeouts.delete(trackingKey);
        }
        
        const duration = Date.now() - startTime;
        log.debug('Operation completed within timeout', { 
          duration, 
          timeoutMs, 
          trackingKey 
        });
      }
      
      return result;
    } catch (error) {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutHandle);
        
        if (trackingKey) {
          this.activeTimeouts.delete(trackingKey);
        }
      }
      throw error;
    }
  }

  /**
   * Wrap a function with timeout and retry logic
   */
  wrapWithTimeout(fn, category, operation = 'standard', options = {}) {
    const timeoutMs = TIMEOUT_CONFIGS[category]?.[operation] || TIMEOUT_CONFIGS.external.standard;
    const {
      retries = 0,
      retryDelay = 1000,
      abortController = null,
      onTimeout = null
    } = options;

    return async (...args) => {
      let lastError;
      
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const trackingKey = `${category}:${operation}:${attempt}`;
          
          const result = await this.withTimeout(
            fn(...args),
            timeoutMs,
            {
              timeoutMessage: `${category} ${operation} operation timed out after ${timeoutMs}ms`,
              onTimeout,
              abortController,
              trackingKey
            }
          );
          
          return result;
        } catch (error) {
          lastError = error;
          
          if (error instanceof TimeoutError && attempt < retries) {
            log.warn(`${category} ${operation} timed out, retrying`, { 
              attempt: attempt + 1, 
              maxAttempts: retries + 1,
              delay: retryDelay 
            });
            
            await sleep(retryDelay * Math.pow(2, attempt)); // Exponential backoff
          } else {
            break;
          }
        }
      }
      
      throw lastError;
    };
  }

  /**
   * Cancel a tracked timeout operation
   */
  cancelTimeout(trackingKey) {
    const timeout = this.activeTimeouts.get(trackingKey);
    if (timeout) {
      this.activeTimeouts.delete(trackingKey);
      this.stats.cancelled++;
      log.debug('Timeout cancelled', { trackingKey });
      return true;
    }
    return false;
  }

  /**
   * Get timeout statistics
   */
  getStats() {
    return {
      ...this.stats,
      active: this.activeTimeouts.size,
      configs: TIMEOUT_CONFIGS
    };
  }

  /**
   * Health check for timeout manager
   */
  healthCheck() {
    const activeCount = this.activeTimeouts.size;
    const timeoutRate = this.stats.created > 0 ? (this.stats.timedOut / this.stats.created) : 0;
    
    return {
      status: timeoutRate > 0.1 ? 'degraded' : 'healthy', // More than 10% timeout rate is concerning
      stats: this.getStats(),
      activeOperations: activeCount,
      timeoutRate: Math.round(timeoutRate * 100) / 100
    };
  }

  /**
   * Clean up expired timeout tracking
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 3600000; // 1 hour
    
    for (const [key, timeout] of this.activeTimeouts.entries()) {
      if (now - timeout.startTime > maxAge) {
        this.activeTimeouts.delete(key);
        log.debug('Cleaned up expired timeout tracking', { key });
      }
    }
  }
}

/**
 * Custom timeout error class
 */
class TimeoutError extends Error {
  constructor(message, timeoutMs, actualDuration) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.actualDuration = actualDuration;
    this.isTimeout = true;
  }
}

// Global timeout manager instance
const timeoutManager = new TimeoutManager();

// Schedule periodic cleanup
setInterval(() => {
  timeoutManager.cleanup();
}, 300000); // Every 5 minutes

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  TimeoutManager,
  TimeoutError,
  timeoutManager,
  TIMEOUT_CONFIGS
};

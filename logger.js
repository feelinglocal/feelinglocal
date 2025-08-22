// logger.js - Structured logging with Pino
const pino = require('pino');

// Create logger instance
const logger = pino({
  name: 'localization-app',
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
    bindings: (bindings) => {
      return {
        pid: bindings.pid,
        hostname: bindings.hostname,
        name: bindings.name
      };
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Use pretty printing in development
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname'
    }
  } : undefined
});

// Enhanced logging functions
const log = {
  // Basic logging
  info: (msg, extra = {}) => logger.info(extra, msg),
  warn: (msg, extra = {}) => logger.warn(extra, msg),
  error: (msg, extra = {}) => logger.error(extra, msg),
  debug: (msg, extra = {}) => logger.debug(extra, msg),

  // Request logging
  request: (req, res, duration) => {
    const logData = {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl || req.url,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      userId: req.user?.id,
      userTier: req.user?.tier,
      orgId: req.user?.orgId,
      statusCode: res.statusCode,
      duration: duration,
      contentLength: res.get('Content-Length')
    };

    if (res.statusCode >= 400) {
      logger.warn(logData, `${req.method} ${req.originalUrl || req.url} - ${res.statusCode}`);
    } else {
      logger.info(logData, `${req.method} ${req.originalUrl || req.url} - ${res.statusCode}`);
    }
  },

  // API call logging (OpenAI, etc.)
  apiCall: (provider, endpoint, duration, tokens = 0, success = true, error = null) => {
    const logData = {
      provider,
      endpoint,
      duration,
      tokens,
      success
    };

    if (error) {
      logData.error = error.message || error;
      logger.error(logData, `API call failed: ${provider}/${endpoint}`);
    } else {
      logger.info(logData, `API call: ${provider}/${endpoint}`);
    }
  },

  // Authentication events
  auth: (event, userId, email, success = true, error = null) => {
    const logData = {
      event,
      userId,
      email,
      success
    };

    if (error) {
      logData.error = error.message || error;
      logger.warn(logData, `Auth event: ${event} failed`);
    } else {
      logger.info(logData, `Auth event: ${event}`);
    }
  },

  // Database operations
  db: (operation, table, duration, success = true, error = null) => {
    const logData = {
      operation,
      table,
      duration,
      success
    };

    if (error) {
      logData.error = error.message || error;
      logger.error(logData, `DB operation failed: ${operation} on ${table}`);
    } else {
      logger.debug(logData, `DB operation: ${operation} on ${table}`);
    }
  },

  // Translation events
  translation: (type, inputLength, outputLength, mode, targetLanguage, userId, duration, success = true, error = null) => {
    const logData = {
      type, // 'single' or 'batch'
      inputLength,
      outputLength,
      mode,
      targetLanguage,
      userId,
      duration,
      success
    };

    if (error) {
      logData.error = error.message || error;
      logger.error(logData, `Translation failed: ${type}`);
    } else {
      logger.info(logData, `Translation completed: ${type}`);
    }
  }
};

module.exports = log;


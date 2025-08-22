// middleware.js - Custom middleware for observability
const { v4: uuidv4 } = require('uuid');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

// Request ID middleware
const requestIdMiddleware = (req, res, next) => {
  // Check if request ID already exists in headers, otherwise generate new one
  req.requestId = req.get('X-Request-Id') || uuidv4();
  req.startTime = Date.now(); // Track request start time
  
  // Set response header
  res.set('X-Request-Id', req.requestId);
  
  next();
};

// Request logging middleware
const requestLoggingMiddleware = (req, res, next) => {
  const startTime = Date.now();
  
  // Log incoming request
  log.debug('Incoming request', {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    userId: req.user?.id,
    userTier: req.user?.tier
  });

  // Override res.end to capture response
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    
    // Log request completion
    log.request(req, res, duration);
    
    // Record metrics
    const route = req.route?.path || req.originalUrl?.split('?')[0] || 'unknown';
    recordMetrics.httpRequest(
      req.method,
      route,
      res.statusCode,
      duration,
      req.user?.tier || 'anonymous'
    );
    
    // Call original end
    originalEnd.apply(this, args);
  };

  next();
};

// Error handling middleware
const errorHandlingMiddleware = (err, req, res, next) => {
  // Log error with context
  log.error('Request error', {
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl || req.url,
    userId: req.user?.id,
    userTier: req.user?.tier
  });

  // Don't expose internal errors in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  const errorResponse = {
    error: isDevelopment ? err.message : 'Internal server error',
    requestId: req.requestId
  };

  if (isDevelopment && err.stack) {
    errorResponse.stack = err.stack;
  }

  // Set appropriate status code
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json(errorResponse);
};

// Rate limit hit recording middleware
const rateLimitHitMiddleware = (req, res, next) => {
  // Override rate limit handler to record metrics
  const originalJson = res.json;
  res.json = function(data) {
    if (res.statusCode === 429) {
      recordMetrics.rateLimitHit('request', req.user?.tier || 'anonymous');
      
      log.warn('Rate limit hit', {
        requestId: req.requestId,
        userId: req.user?.id,
        userTier: req.user?.tier,
        ip: req.ip,
        endpoint: req.originalUrl || req.url
      });
    }
    
    return originalJson.call(this, data);
  };
  
  next();
};

// Security headers middleware
const securityHeadersMiddleware = (req, res, next) => {
  // Add security headers
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  
  next();
};

// Health check for dependencies
const healthCheckDependencies = async () => {
  const checks = {};
  
  try {
    // Check database connection
    const db = require('./database');
    await db.get('SELECT 1');
    checks.database = { status: 'healthy', latency: 0 };
  } catch (error) {
    checks.database = { status: 'unhealthy', error: error.message };
  }
  
  try {
    // Check OpenAI API (quick test)
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    const startTime = Date.now();
    await openai.models.list(); // Quick API call
    const latency = Date.now() - startTime;
    
    checks.openai = { status: 'healthy', latency };
  } catch (error) {
    checks.openai = { status: 'unhealthy', error: error.message };
  }
  
  // Overall health status
  const allHealthy = Object.values(checks).every(check => check.status === 'healthy');
  
  return {
    status: allHealthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };
};

module.exports = {
  requestIdMiddleware,
  requestLoggingMiddleware,
  errorHandlingMiddleware,
  rateLimitHitMiddleware,
  securityHeadersMiddleware,
  healthCheckDependencies
};

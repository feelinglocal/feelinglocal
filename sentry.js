// sentry.js - Error tracking setup
const Sentry = require('@sentry/node');

// Initialize Sentry only if DSN is provided
const initSentry = (app) => {
  const sentryDsn = process.env.SENTRY_DSN;
  
  if (!sentryDsn) {
    console.log('ℹ️ Sentry DSN not provided, skipping error tracking setup');
    return null;
  }

  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      // Enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // Enable Express.js middleware tracing
      new Sentry.Integrations.Express({ app }),
    ],
    beforeSend(event) {
      // Filter out certain errors in production
      if (process.env.NODE_ENV === 'production') {
        // Don't send validation errors
        if (event.exception?.values?.[0]?.type === 'ValidationError') {
          return null;
        }
        
        // Don't send rate limit errors
        if (event.tags?.statusCode === '429') {
          return null;
        }
      }
      
      return event;
    }
  });

  console.log('✅ Sentry error tracking initialized');
  return Sentry;
};

// Middleware to add user context to Sentry
const sentryUserMiddleware = (req, res, next) => {
  if (req.user) {
    Sentry.setUser({
      id: req.user.id,
      email: req.user.email,
      tier: req.user.tier
    });
  }
  
  // Add request context
  Sentry.setTag('requestId', req.requestId);
  Sentry.setContext('request', {
    method: req.method,
    url: req.originalUrl || req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });
  
  next();
};

// Helper function to capture exception with context
const captureException = (error, context = {}) => {
  Sentry.withScope((scope) => {
    // Add extra context
    Object.keys(context).forEach(key => {
      scope.setExtra(key, context[key]);
    });
    
    Sentry.captureException(error);
  });
};

// Helper function to capture message with context
const captureMessage = (message, level = 'info', context = {}) => {
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    
    // Add extra context
    Object.keys(context).forEach(key => {
      scope.setExtra(key, context[key]);
    });
    
    Sentry.captureMessage(message);
  });
};

module.exports = {
  initSentry,
  sentryUserMiddleware,
  captureException,
  captureMessage,
  Sentry
};


// development-bypass.js - Development mode authentication bypass
const log = require('./logger');

/**
 * Development authentication bypass middleware
 * ONLY for development - never use in production
 */
function developmentBypass(req, res, next) {
  // Only allow in development mode
  if (process.env.NODE_ENV === 'production') {
    return next(); // Don't bypass in production
  }
  
  // Check if bypass is enabled
  if (process.env.DEV_AUTH_BYPASS !== 'true') {
    return next(); // Bypass not enabled
  }
  
  // Skip authentication for development
  if (!req.user) {
    req.user = {
      id: 'dev-user-1',
      email: 'dev@localhost',
      name: 'Development User', 
      tier: 'business', // Highest tier for development
      isDevelopmentUser: true
    };
    
    log.debug('Development authentication bypass active', { 
      userId: req.user.id,
      path: req.path 
    });
  }
  
  next();
}

/**
 * Add development routes for quick testing
 */
function setupDevelopmentRoutes(app) {
  if (process.env.NODE_ENV === 'production') {
    return; // Don't add dev routes in production
  }
  
  // Quick login endpoint for development
  app.post('/dev/quick-login', (req, res) => {
  const { tier = 'business' } = req.body;
    
    const devUser = {
      id: 'dev-user-' + Date.now(),
      email: 'dev@localhost',
      name: 'Development User',
      tier: tier,
      isDevelopmentUser: true
    };
    
    const { generateToken } = require('./auth');
    const token = generateToken(devUser);
    
    res.json({
      message: 'Development login successful',
      user: devUser,
      token,
      warning: 'This is a development-only feature'
    });
  });
  
  // Development status endpoint
  app.get('/dev/status', (req, res) => {
    res.json({
      environment: process.env.NODE_ENV,
      authBypass: process.env.DEV_AUTH_BYPASS === 'true',
      user: req.user || null,
      timestamp: new Date().toISOString()
    });
  });
}

module.exports = {
  developmentBypass,
  setupDevelopmentRoutes
};



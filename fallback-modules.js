// fallback-modules.js - Create fallback implementations for missing modules
const fs = require('fs');
const path = require('path');

// Create fallback modules to prevent server crashes
const fallbackModules = {
  'websocket.js': `
// Fallback WebSocket module
module.exports = {
  initWebSocket: () => ({ init: () => console.log('WebSocket fallback active') }),
  webSocketManager: { 
    init: () => {},
    sendJobProgress: () => {},
    sendJobComplete: () => {},
    sendJobFailure: () => {},
    shutdown: () => Promise.resolve()
  },
  webSocketMiddleware: (req, res, next) => {
    req.websocket = {
      sendJobProgress: () => {},
      sendJobComplete: () => {},
      sendJobFailure: () => {}
    };
    next();
  }
};`,

  'sso.js': `
// Fallback SSO module
module.exports = {
  ssoManager: { 
    init: () => Promise.resolve(),
    isInitialized: false,
    healthCheck: () => ({ status: 'disabled' })
  },
  setupSSORoutes: () => console.log('SSO routes fallback - no routes added'),
  ssoMiddleware: (req, res, next) => {
    req.sso = { isEnabled: () => false, getProviders: () => [] };
    next();
  }
};`,

  'encryption.js': `
// Fallback encryption module
module.exports = {
  encryptionManager: {
    healthCheck: () => ({ status: 'disabled' })
  },
  encryptionMiddleware: (req, res, next) => {
    req.encryption = {
      encryptText: (text) => text,
      decryptText: (text) => text,
      healthCheck: () => ({ status: 'disabled' })
    };
    next();
  },
  encryptResponseMiddleware: (req, res, next) => next()
};`,

  'gdpr-compliance.js': `
// Fallback GDPR module
module.exports = {
  gdprManager: {
    healthCheck: () => ({ status: 'disabled' }),
    getDataProcessingInfo: () => ({ status: 'not_configured' })
  },
  gdprConsentMiddleware: (req, res, next) => {
    req.gdpr = { healthCheck: () => ({ status: 'disabled' }) };
    next();
  },
  requireConsent: () => (req, res, next) => next(),
  scheduleGDPRCleanup: () => console.log('GDPR cleanup fallback - no cleanup scheduled')
};`,

  'advanced-audit.js': `
// Fallback audit module
module.exports = {
  advancedAuditManager: {
    init: () => Promise.resolve(),
    healthCheck: () => ({ status: 'disabled' })
  },
  advancedAuditMiddleware: (req, res, next) => next()
};`,

  'cdn-integration.js': `
// Fallback CDN module
module.exports = {
  cdnManager: {
    config: { enabled: false },
    getCDNStatistics: () => ({ enabled: false }),
    healthCheck: () => ({ status: 'disabled' }),
    purgeCache: () => Promise.resolve({ success: false, reason: 'CDN disabled' })
  },
  cdnMiddleware: (req, res, next) => {
    req.cdn = {
      getUrl: (path) => path,
      healthCheck: () => ({ status: 'disabled' })
    };
    next();
  },
  initCDN: () => Promise.resolve()
};`,

  'translation-cache.js': `
// Fallback cache module
module.exports = {
  translationCache: {
    getStats: () => ({ hitRate: 0, enabled: false }),
    healthCheck: () => ({ status: 'disabled' }),
    invalidateCache: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  },
  cacheMiddleware: (req, res, next) => {
    req.cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      healthCheck: () => ({ status: 'disabled' })
    };
    next();
  },
  initTranslationCache: () => Promise.resolve(),
  cacheAwareTranslation: async (fn, cacheParams, translationParams) => {
    return await fn(translationParams);
  }
};`,

  'translation-memory.js': `
// Fallback translation memory module
module.exports = {
  translationMemory: {
    init: () => Promise.resolve(),
    getTranslationSuggestions: () => Promise.resolve([]),
    updateQualityScore: () => Promise.resolve(),
    getTMStatistics: () => Promise.resolve({ enabled: false }),
    healthCheck: () => ({ status: 'disabled' }),
    shutdown: () => Promise.resolve()
  },
  translationMemoryMiddleware: (req, res, next) => {
    req.tm = {
      findMatches: () => Promise.resolve([]),
      getSuggestions: () => Promise.resolve([]),
      healthCheck: () => ({ status: 'disabled' })
    };
    next();
  },
  initTranslationMemory: () => Promise.resolve()
};`
};

async function createFallbackModules() {
  console.log('🔧 Creating fallback modules for missing dependencies...');
  
  for (const [filename, content] of Object.entries(fallbackModules)) {
    try {
      if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, content);
        console.log('✅ Created fallback:', filename);
      } else {
        console.log('⚠️', filename, 'already exists, skipping');
      }
    } catch (error) {
      console.error('❌ Failed to create', filename + ':', error.message);
    }
  }
  
  console.log('🔧 Fallback modules created');
}

if (require.main === module) {
  createFallbackModules().catch(console.error);
}

module.exports = { createFallbackModules };

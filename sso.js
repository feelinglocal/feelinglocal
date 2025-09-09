// sso.js - Single Sign-On (SSO) integration with SAML
const passport = require('passport');
const { Strategy: SamlStrategy, MultiSamlStrategy } = require('@node-saml/passport-saml');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { AuditService, AUDIT_ACTIONS } = require('./audit');

/**
 * SSO Configuration Manager
 */
class SSOManager {
  constructor() {
    this.providers = new Map();
    this.isInitialized = false;
  }

  /**
   * Initialize SSO system
   */
  async init() {
    try {
      // Load SSO configuration
      await this.loadProviderConfigurations();
      
      // Setup Passport strategies
      this.setupSAMLStrategy();
      this.setupMultiSAMLStrategy();
      
      this.isInitialized = true;
      log.info('SSO system initialized successfully', { 
        providerCount: this.providers.size 
      });
    } catch (error) {
      log.error('Failed to initialize SSO system', { error: error.message });
      throw error;
    }
  }

  /**
   * Load provider configurations from environment/files
   */
  async loadProviderConfigurations() {
    // Default SAML provider configuration
    const defaultProvider = {
      name: 'default',
      enabled: process.env.SAML_ENABLED === 'true',
      config: {
        entryPoint: process.env.SAML_ENTRY_POINT,
        issuer: process.env.SAML_ISSUER || 'localization-app',
        callbackUrl: process.env.SAML_CALLBACK_URL || '/auth/saml/callback',
        idpCert: process.env.SAML_IDP_CERT || '',
        privateKey: process.env.SAML_PRIVATE_KEY || '',
        cert: process.env.SAML_CERT || '',
        identifierFormat: process.env.SAML_IDENTIFIER_FORMAT || null,
        signatureAlgorithm: process.env.SAML_SIGNATURE_ALGORITHM || 'sha256',
        digestAlgorithm: process.env.SAML_DIGEST_ALGORITHM || 'sha256',
        authnContext: process.env.SAML_AUTHN_CONTEXT ? 
          process.env.SAML_AUTHN_CONTEXT.split(',') : 
          ['http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password'],
        wantAssertionsSigned: process.env.SAML_WANT_ASSERTIONS_SIGNED !== 'false',
        wantAuthnResponseSigned: process.env.SAML_WANT_RESPONSE_SIGNED !== 'false'
      }
    };

    if (defaultProvider.enabled && defaultProvider.config.entryPoint) {
      this.providers.set('default', defaultProvider);
    }

    // Load additional providers from configuration files
    await this.loadProvidersFromFiles();

    // Azure AD provider
    if (process.env.AZURE_AD_ENABLED === 'true') {
      this.providers.set('azure', {
        name: 'azure',
        enabled: true,
        config: {
          entryPoint: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/saml2`,
          issuer: process.env.AZURE_APP_ID,
          callbackUrl: process.env.AZURE_CALLBACK_URL || '/auth/azure/callback',
          idpCert: process.env.AZURE_IDP_CERT,
          identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          signatureAlgorithm: 'sha256'
        }
      });
    }

    // Okta provider
    if (process.env.OKTA_ENABLED === 'true') {
      this.providers.set('okta', {
        name: 'okta',
        enabled: true,
        config: {
          entryPoint: process.env.OKTA_ENTRY_POINT,
          issuer: process.env.OKTA_ISSUER,
          callbackUrl: process.env.OKTA_CALLBACK_URL || '/auth/okta/callback',
          idpCert: process.env.OKTA_IDP_CERT,
          identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
        }
      });
    }
  }

  /**
   * Load provider configurations from files
   */
  async loadProvidersFromFiles() {
    const configDir = path.join(__dirname, 'config', 'sso');
    
    try {
      if (fs.existsSync(configDir)) {
        const files = fs.readdirSync(configDir);
        
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const configPath = path.join(configDir, file);
              const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              const providerName = path.basename(file, '.json');
              
              this.providers.set(providerName, {
                name: providerName,
                enabled: config.enabled !== false,
                config: config.saml || config
              });
              
              log.info('Loaded SSO provider configuration', { provider: providerName });
            } catch (error) {
              log.warn('Failed to load SSO provider config', { file, error: error.message });
            }
          }
        }
      }
    } catch (error) {
      log.debug('SSO config directory not found, using environment configuration only');
    }
  }

  /**
   * Setup default SAML strategy
   */
  setupSAMLStrategy() {
    const defaultProvider = this.providers.get('default');
    
    if (!defaultProvider || !defaultProvider.enabled) {
      log.info('Default SAML provider not configured or disabled');
      return;
    }

    const strategy = new SamlStrategy(
      defaultProvider.config,
      this.handleSAMLProfile.bind(this),
      this.handleSAMLLogout.bind(this)
    );

    passport.use('saml', strategy);
    log.info('Default SAML strategy configured');
  }

  /**
   * Setup multi-SAML strategy for multiple providers
   */
  setupMultiSAMLStrategy() {
    if (this.providers.size <= 1) {
      return; // No need for multi-SAML with single provider
    }

    const strategy = new MultiSamlStrategy(
      {
        passReqToCallback: true,
        getSamlOptions: this.getSamlOptions.bind(this)
      },
      this.handleMultiSAMLProfile.bind(this),
      this.handleMultiSAMLLogout.bind(this)
    );

    passport.use('multi-saml', strategy);
    log.info('Multi-SAML strategy configured', { providerCount: this.providers.size });
  }

  /**
   * Get SAML options for MultiSamlStrategy
   */
  getSamlOptions(request, done) {
    try {
      const providerId = request.params.provider || request.query.provider || 'default';
      const provider = this.providers.get(providerId);
      
      if (!provider || !provider.enabled) {
        return done(new Error(`SSO provider '${providerId}' not found or disabled`));
      }

      // Adjust callback URL for multi-provider
      const config = { ...provider.config };
      if (providerId !== 'default') {
        config.callbackUrl = config.callbackUrl.replace('/callback', `/${providerId}/callback`);
      }

      done(null, config);
    } catch (error) {
      done(error);
    }
  }

  /**
   * Handle SAML profile for single provider
   */
  async handleSAMLProfile(profile, done) {
    try {
      log.info('SAML authentication success', { 
        nameID: profile.nameID,
        email: profile.email || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']
      });

      const user = await this.processUserProfile(profile, 'default');
      return done(null, user);
    } catch (error) {
      log.error('SAML profile processing failed', { error: error.message });
      return done(error);
    }
  }

  /**
   * Handle multi-SAML profile
   */
  async handleMultiSAMLProfile(req, profile, done) {
    try {
      const providerId = req.params.provider || 'default';
      
      log.info('Multi-SAML authentication success', { 
        provider: providerId,
        nameID: profile.nameID,
        email: profile.email
      });

      const user = await this.processUserProfile(profile, providerId);
      return done(null, user);
    } catch (error) {
      log.error('Multi-SAML profile processing failed', { error: error.message });
      return done(error);
    }
  }

  /**
   * Process user profile from SAML response
   */
  async processUserProfile(profile, providerId) {
    const db = require('./database');
    
    // Extract user information from SAML profile
    const email = profile.email || 
                 profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ||
                 profile['http://schemas.xmlsoap.org/claims/emailaddress'];
    
    const name = profile.displayName || 
                profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ||
                profile['http://schemas.microsoft.com/ws/2008/06/identity/claims/name'] ||
                email;
    
    const upn = profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn'];
    const groups = profile['http://schemas.xmlsoap.org/claims/Group'] || [];

    if (!email) {
      throw new Error('Email not found in SAML profile');
    }

    // Find or create user
    let user = await db.findUserByEmail(email);
    
    if (!user) {
      // Create new SSO user
      user = await db.createUser({
        email,
        name,
        tier: this.determineTierFromGroups(groups),
        ssoProvider: providerId,
        ssoNameID: profile.nameID,
        ssoUPN: upn,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        isSSO: true
      });

      log.info('New SSO user created', { 
        userId: user.id, 
        email, 
        provider: providerId 
      });

      // Audit log
      await AuditService.log(AUDIT_ACTIONS.USER_CREATED, 'users', user.id, {
        method: 'sso',
        provider: providerId,
        email
      });
    } else {
      // Update existing user's SSO information
      await db.updateUser(user.id, {
        lastLogin: new Date().toISOString(),
        ssoProvider: providerId,
        ssoNameID: profile.nameID,
        ssoUPN: upn
      });

      // Audit log
      await AuditService.log(AUDIT_ACTIONS.USER_LOGIN, 'users', user.id, {
        method: 'sso',
        provider: providerId,
        ip: profile._ip
      });
    }

    return user;
  }

  /**
   * Determine user tier based on SAML groups
   */
  determineTierFromGroups(groups) {
    if (!Array.isArray(groups)) {
      groups = groups ? [groups] : [];
    }

    // Map SAML groups to application tiers
    const tierMapping = {
      'Localization-Admin': 'business',
      'Localization-Pro': 'pro',
      'Localization-Team': 'business',
      'Localization-Business': 'business',
      'Localization-Free': 'free'
    };

    for (const group of groups) {
      if (tierMapping[group]) {
        return tierMapping[group];
      }
    }

    // Default tier
    return process.env.SSO_DEFAULT_TIER || 'pro';
  }

  /**
   * Handle SAML logout
   */
  async handleSAMLLogout(profile, done) {
    try {
      log.info('SAML logout', { nameID: profile.nameID });
      
      // Find user by nameID
      const db = require('./database');
      const user = await db.findUserBySSONameID(profile.nameID);
      
      if (user) {
        // Audit log
        await AuditService.log(AUDIT_ACTIONS.USER_LOGOUT, 'users', user.id, {
          method: 'sso',
          nameID: profile.nameID
        });
      }

      return done(null, user);
    } catch (error) {
      log.error('SAML logout failed', { error: error.message });
      return done(error);
    }
  }

  /**
   * Handle multi-SAML logout
   */
  async handleMultiSAMLLogout(req, profile, done) {
    try {
      const providerId = req.params.provider || 'default';
      
      log.info('Multi-SAML logout', { 
        provider: providerId, 
        nameID: profile.nameID 
      });

      const db = require('./database');
      const user = await db.findUserBySSONameID(profile.nameID, providerId);
      
      if (user) {
        await AuditService.log(AUDIT_ACTIONS.USER_LOGOUT, 'users', user.id, {
          method: 'sso',
          provider: providerId,
          nameID: profile.nameID
        });
      }

      return done(null, user);
    } catch (error) {
      log.error('Multi-SAML logout failed', { error: error.message });
      return done(error);
    }
  }

  /**
   * Generate Service Provider metadata
   */
  generateMetadata(providerId = 'default') {
    try {
      const provider = this.providers.get(providerId);
      if (!provider) {
        throw new Error(`Provider '${providerId}' not found`);
      }

      const strategy = passport._strategy('saml') || passport._strategy('multi-saml');
      if (!strategy) {
        throw new Error('SAML strategy not configured');
      }

      // Read certificates
      const decryptionCert = this.readCertFile(provider.config.cert);
      const signingCert = this.readCertFile(provider.config.cert);

      return strategy.generateServiceProviderMetadata(decryptionCert, signingCert);
    } catch (error) {
      log.error('Failed to generate SP metadata', { providerId, error: error.message });
      throw error;
    }
  }

  /**
   * Read certificate file
   */
  readCertFile(certPath) {
    if (!certPath) return '';
    
    try {
      if (fs.existsSync(certPath)) {
        return fs.readFileSync(certPath, 'utf8');
      } else {
        // Assume it's the certificate content itself
        return certPath;
      }
    } catch (error) {
      log.warn('Failed to read certificate file', { certPath, error: error.message });
      return '';
    }
  }

  /**
   * Get available SSO providers
   */
  getProviders() {
    const providers = [];
    
    for (const [id, provider] of this.providers.entries()) {
      if (provider.enabled) {
        providers.push({
          id,
          name: provider.name,
          displayName: provider.displayName || provider.name,
          type: 'saml',
          loginUrl: `/auth/saml/login${id !== 'default' ? `/${id}` : ''}`,
          logoutUrl: `/auth/saml/logout${id !== 'default' ? `/${id}` : ''}`
        });
      }
    }

    return providers;
  }

  /**
   * Health check for SSO system
   */
  healthCheck() {
    const enabledProviders = Array.from(this.providers.values()).filter(p => p.enabled);
    
    return {
      status: this.isInitialized ? 'healthy' : 'unhealthy',
      initialized: this.isInitialized,
      providersTotal: this.providers.size,
      providersEnabled: enabledProviders.length,
      providers: enabledProviders.map(p => ({
        name: p.name,
        hasEntryPoint: !!p.config.entryPoint,
        hasCert: !!p.config.idpCert
      }))
    };
  }
}

// Global SSO manager instance
const ssoManager = new SSOManager();

/**
 * Setup SSO routes for Express app
 */
function setupSSORoutes(app) {
  // Default SAML login
  app.get('/auth/saml/login', (req, res, next) => {
    if (!ssoManager.isInitialized) {
      return res.status(503).json({ error: 'SSO not configured' });
    }
    
    passport.authenticate('saml', { 
      failureRedirect: '/login?error=sso_failed',
      additionalParams: req.query.additionalParams ? JSON.parse(req.query.additionalParams) : {}
    })(req, res, next);
  });

  // Multi-provider SAML login
  app.get('/auth/saml/login/:provider', (req, res, next) => {
    if (!ssoManager.isInitialized) {
      return res.status(503).json({ error: 'SSO not configured' });
    }

    const providerId = req.params.provider;
    if (!ssoManager.providers.has(providerId)) {
      return res.status(404).json({ error: 'SSO provider not found' });
    }
    
    passport.authenticate('multi-saml', { 
      failureRedirect: `/login?error=sso_failed&provider=${providerId}`,
      additionalParams: req.query.additionalParams ? JSON.parse(req.query.additionalParams) : {}
    })(req, res, next);
  });

  // Default SAML callback
  app.post('/auth/saml/callback', 
    require('body-parser').urlencoded({ extended: false }),
    passport.authenticate('saml', { 
      failureRedirect: '/login?error=sso_callback_failed' 
    }),
    (req, res) => {
      log.info('SAML authentication successful', { 
        userId: req.user.id, 
        email: req.user.email 
      });
      res.redirect(req.session.returnTo || '/');
    }
  );

  // Multi-provider SAML callback
  app.post('/auth/saml/callback/:provider', 
    require('body-parser').urlencoded({ extended: false }),
    passport.authenticate('multi-saml', { 
      failureRedirect: '/login?error=sso_callback_failed' 
    }),
    (req, res) => {
      const providerId = req.params.provider;
      log.info('Multi-SAML authentication successful', { 
        provider: providerId,
        userId: req.user.id, 
        email: req.user.email 
      });
      res.redirect(req.session.returnTo || '/');
    }
  );

  // SSO logout
  app.get('/auth/saml/logout', (req, res) => {
    if (!req.user) {
      return res.redirect('/');
    }

    const strategy = passport._strategy('saml');
    if (strategy) {
      strategy.logout(req, (err, url) => {
        if (err) {
          log.error('SAML logout error', { error: err.message });
          return res.redirect('/logout');
        }
        res.redirect(url);
      });
    } else {
      res.redirect('/logout');
    }
  });

  // Service Provider metadata endpoint
  app.get('/auth/saml/metadata/:provider?', (req, res) => {
    try {
      const providerId = req.params.provider || 'default';
      const metadata = ssoManager.generateMetadata(providerId);
      
      res.type('application/xml');
      res.send(metadata);
    } catch (error) {
      log.error('Failed to generate SAML metadata', { error: error.message });
      res.status(500).json({ error: 'Failed to generate metadata' });
    }
  });

  // SSO providers list
  app.get('/auth/sso/providers', (req, res) => {
    try {
      const providers = ssoManager.getProviders();
      res.json({ providers });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get providers' });
    }
  });

  // SSO health check
  app.get('/auth/sso/health', (req, res) => {
    const health = ssoManager.healthCheck();
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
  });
}

/**
 * Middleware to add SSO capabilities to request context
 */
function ssoMiddleware(req, res, next) {
  req.sso = {
    isEnabled: () => ssoManager.isInitialized && ssoManager.providers.size > 0,
    getProviders: () => ssoManager.getProviders(),
    healthCheck: () => ssoManager.healthCheck()
  };
  next();
}

/**
 * Check if user authenticated via SSO
 */
function isSSO(req) {
  return req.user && req.user.isSSO === true;
}

/**
 * Require SSO authentication
 */
function requireSSO(req, res, next) {
  if (!isSSO(req)) {
    return res.status(401).json({ 
      error: 'SSO authentication required',
      ssoProviders: ssoManager.getProviders()
    });
  }
  next();
}

module.exports = {
  SSOManager,
  ssoManager,
  setupSSORoutes,
  ssoMiddleware,
  isSSO,
  requireSSO
};



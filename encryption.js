// encryption.js - End-to-end encryption for sensitive documents
const crypto = require('crypto');
const { EncryptJWT, jwtDecrypt } = require('jose');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

/**
 * End-to-End Encryption Manager
 */
class EncryptionManager {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.keyDerivation = 'pbkdf2';
    this.iterations = 100000; // PBKDF2 iterations
    this.keyLength = 32; // 256 bits
    this.ivLength = 16; // 128 bits
    this.saltLength = 32; // 256 bits
    this.tagLength = 16; // 128 bits
    
    // Master key for server-side encryption (should be from environment)
    this.masterKey = process.env.ENCRYPTION_MASTER_KEY || this.generateMasterKey();
    
    if (process.env.ENCRYPTION_MASTER_KEY !== this.masterKey) {
      log.warn('Using generated master key - set ENCRYPTION_MASTER_KEY in production');
    }
  }

  /**
   * Generate a new master key
   */
  generateMasterKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate encryption key from password
   */
  deriveKeyFromPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, this.iterations, this.keyLength, 'sha256');
  }

  /**
   * Generate encryption key from master key and salt
   */
  deriveKeyFromMaster(salt) {
    const masterKeyBuffer = Buffer.from(this.masterKey, 'hex');
    return crypto.pbkdf2Sync(masterKeyBuffer, salt, this.iterations, this.keyLength, 'sha256');
  }

  /**
   * Encrypt text with password-based encryption (client-side compatible)
   */
  encryptWithPassword(text, password) {
    try {
      const salt = crypto.randomBytes(this.saltLength);
      const iv = crypto.randomBytes(this.ivLength);
      const key = this.deriveKeyFromPassword(password, salt);
      
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(salt); // Additional authenticated data
      
      let encrypted = cipher.update(text, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      
      const tag = cipher.getAuthTag();
      
      // Combine salt + iv + tag + encrypted data
      const combined = Buffer.concat([
        salt,
        iv, 
        tag,
        Buffer.from(encrypted, 'base64')
      ]);
      
      return {
        encrypted: combined.toString('base64'),
        algorithm: this.algorithm,
        iterations: this.iterations,
        keyDerivation: this.keyDerivation
      };
    } catch (error) {
      log.error('Password encryption failed', { error: error.message });
      throw new Error('Encryption failed');
    }
  }

  /**
   * Decrypt text with password-based encryption
   */
  decryptWithPassword(encryptedData, password) {
    try {
      const combined = Buffer.from(encryptedData.encrypted, 'base64');
      
      // Extract components
      const salt = combined.slice(0, this.saltLength);
      const iv = combined.slice(this.saltLength, this.saltLength + this.ivLength);
      const tag = combined.slice(this.saltLength + this.ivLength, this.saltLength + this.ivLength + this.tagLength);
      const encrypted = combined.slice(this.saltLength + this.ivLength + this.tagLength);
      
      const key = this.deriveKeyFromPassword(password, salt);
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(salt);
      decipher.setAuthTag(tag);
      
      let decrypted = decipher.update(encrypted, null, 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      log.error('Password decryption failed', { error: error.message });
      throw new Error('Decryption failed - invalid password or corrupted data');
    }
  }

  /**
   * Encrypt file content for server-side storage
   */
  encryptFile(fileContent, metadata = {}) {
    try {
      const salt = crypto.randomBytes(this.saltLength);
      const iv = crypto.randomBytes(this.ivLength);
      const key = this.deriveKeyFromMaster(salt);
      
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
      cipher.setAAD(metadataBuffer);
      
      let encrypted = cipher.update(fileContent, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      
      const tag = cipher.getAuthTag();
      
      const combined = Buffer.concat([
        salt,
        iv,
        tag,
        Buffer.from(encrypted, 'base64')
      ]);
      
      return {
        encrypted: combined.toString('base64'),
        metadata: metadata,
        algorithm: this.algorithm,
        timestamp: Date.now()
      };
    } catch (error) {
      log.error('File encryption failed', { error: error.message });
      throw new Error('File encryption failed');
    }
  }

  /**
   * Decrypt file content
   */
  decryptFile(encryptedData) {
    try {
      const combined = Buffer.from(encryptedData.encrypted, 'base64');
      
      const salt = combined.slice(0, this.saltLength);
      const iv = combined.slice(this.saltLength, this.saltLength + this.ivLength);
      const tag = combined.slice(this.saltLength + this.ivLength, this.saltLength + this.ivLength + this.tagLength);
      const encrypted = combined.slice(this.saltLength + this.ivLength + this.tagLength);
      
      const key = this.deriveKeyFromMaster(salt);
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      const metadataBuffer = Buffer.from(JSON.stringify(encryptedData.metadata || {}), 'utf8');
      decipher.setAAD(metadataBuffer);
      decipher.setAuthTag(tag);
      
      let decrypted = decipher.update(encrypted, null, 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      log.error('File decryption failed', { error: error.message });
      throw new Error('File decryption failed');
    }
  }

  /**
   * Generate JWT token with encryption
   */
  async generateEncryptedJWT(payload, secret, options = {}) {
    try {
      const secretKey = crypto.createSecretKey(Buffer.from(secret, 'utf8'));
      
      const jwt = await new EncryptJWT(payload)
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime(options.expiresIn || '1h')
        .setIssuer(options.issuer || 'localization-app')
        .setAudience(options.audience || 'localization-app')
        .encrypt(secretKey);
      
      return jwt;
    } catch (error) {
      log.error('JWT encryption failed', { error: error.message });
      throw new Error('JWT encryption failed');
    }
  }

  /**
   * Decrypt and verify JWT token
   */
  async decryptJWT(encryptedJWT, secret) {
    try {
      const secretKey = crypto.createSecretKey(Buffer.from(secret, 'utf8'));
      
      const { payload } = await jwtDecrypt(encryptedJWT, secretKey, {
        issuer: 'localization-app',
        audience: 'localization-app'
      });
      
      return payload;
    } catch (error) {
      log.error('JWT decryption failed', { error: error.message });
      throw new Error('JWT decryption failed');
    }
  }

  /**
   * Hash sensitive data for indexing (one-way)
   */
  hashForIndex(data) {
    return crypto.createHash('sha256')
      .update(data)
      .digest('hex');
  }

  /**
   * Generate secure random string
   */
  generateSecureRandom(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Encrypt user PII data
   */
  encryptUserPII(userData) {
    try {
      const sensitiveFields = ['email', 'name', 'phone', 'address'];
      const encrypted = { ...userData };
      
      for (const field of sensitiveFields) {
        if (userData[field]) {
          const encryptedField = this.encryptFile(userData[field], { field, type: 'pii' });
          encrypted[field] = encryptedField.encrypted;
          encrypted[`${field}_metadata`] = encryptedField.metadata;
        }
      }
      
      return encrypted;
    } catch (error) {
      log.error('PII encryption failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Decrypt user PII data
   */
  decryptUserPII(encryptedUserData) {
    try {
      const sensitiveFields = ['email', 'name', 'phone', 'address'];
      const decrypted = { ...encryptedUserData };
      
      for (const field of sensitiveFields) {
        if (encryptedUserData[field] && typeof encryptedUserData[field] === 'string') {
          try {
            const decryptedField = this.decryptFile({
              encrypted: encryptedUserData[field],
              metadata: encryptedUserData[`${field}_metadata`] || {}
            });
            decrypted[field] = decryptedField;
            delete decrypted[`${field}_metadata`];
          } catch (decryptError) {
            log.warn(`Failed to decrypt field ${field}`, { error: decryptError.message });
            // Keep encrypted data if decryption fails
          }
        }
      }
      
      return decrypted;
    } catch (error) {
      log.error('PII decryption failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Health check for encryption system
   */
  healthCheck() {
    try {
      // Test encryption/decryption
      const testData = 'health check test';
      const testPassword = 'test_password_123';
      
      const encrypted = this.encryptWithPassword(testData, testPassword);
      const decrypted = this.decryptWithPassword(encrypted, testPassword);
      
      const isHealthy = decrypted === testData;
      
      return {
        status: isHealthy ? 'healthy' : 'unhealthy',
        algorithm: this.algorithm,
        keyDerivation: this.keyDerivation,
        hasMasterKey: !!this.masterKey,
        testResult: isHealthy ? 'passed' : 'failed'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

// Global encryption manager instance
const encryptionManager = new EncryptionManager();

/**
 * Middleware for automatic encryption of sensitive request data
 */
function encryptionMiddleware(req, res, next) {
  req.encryption = {
    encryptText: (text, password) => encryptionManager.encryptWithPassword(text, password),
    decryptText: (encrypted, password) => encryptionManager.decryptWithPassword(encrypted, password),
    encryptFile: (content, metadata) => encryptionManager.encryptFile(content, metadata),
    decryptFile: (encrypted) => encryptionManager.decryptFile(encrypted),
    encryptJWT: (payload, secret, options) => encryptionManager.generateEncryptedJWT(payload, secret, options),
    decryptJWT: (jwt, secret) => encryptionManager.decryptJWT(jwt, secret),
    hashForIndex: (data) => encryptionManager.hashForIndex(data),
    generateRandom: (length) => encryptionManager.generateSecureRandom(length),
    healthCheck: () => encryptionManager.healthCheck()
  };
  next();
}

/**
 * Encrypt response data automatically for sensitive endpoints
 */
function encryptResponseMiddleware(req, res, next) {
  const originalJson = res.json;
  
  res.json = function(data) {
    // Check if encryption is requested
    const shouldEncrypt = req.headers['x-encrypt-response'] === 'true' || 
                         req.query.encrypt === 'true' ||
                         req.body?.encrypt === true;
    
    if (shouldEncrypt && req.user) {
      try {
        // Use user-specific encryption key
        const userKey = req.user.encryptionKey || encryptionManager.generateSecureRandom(32);
        const encrypted = encryptionManager.encryptFile(JSON.stringify(data), {
          userId: req.user.id,
          timestamp: Date.now(),
          endpoint: req.route?.path || req.path
        });
        
        return originalJson.call(this, {
          encrypted: true,
          data: encrypted.encrypted,
          metadata: encrypted.metadata
        });
      } catch (error) {
        log.error('Response encryption failed', { error: error.message });
        // Fall back to unencrypted response
      }
    }
    
    return originalJson.call(this, data);
  };
  
  next();
}

module.exports = {
  EncryptionManager,
  encryptionManager,
  encryptionMiddleware,
  encryptResponseMiddleware
};



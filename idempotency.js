// idempotency.js - Idempotency key handling to prevent duplicate operations
const db = require('./database');
const log = require('./logger');

class IdempotencyService {
  // Store idempotency key with response
  static async storeIdempotencyResult(key, userId, response, expiresInSeconds = 3600) {
    try {
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
      
      await db.run(`
        INSERT OR REPLACE INTO idempotency_keys 
        (key, user_id, response_data, expires_at)
        VALUES (?, ?, ?, ?)
      `, [key, userId, JSON.stringify(response), expiresAt.toISOString()]);

      log.debug('Idempotency result stored', { key, userId });
    } catch (error) {
      log.error('Failed to store idempotency result', { 
        error: error.message, 
        key, 
        userId 
      });
    }
  }

  // Get stored idempotency result
  static async getIdempotencyResult(key, userId) {
    try {
      const result = await db.get(`
        SELECT response_data, expires_at
        FROM idempotency_keys
        WHERE key = ? AND user_id = ? AND expires_at > datetime('now')
      `, [key, userId]);

      if (result) {
        log.debug('Idempotency result found', { key, userId });
        return JSON.parse(result.response_data);
      }

      return null;
    } catch (error) {
      log.error('Failed to get idempotency result', { 
        error: error.message, 
        key, 
        userId 
      });
      return null;
    }
  }

  // Clean up expired idempotency keys
  static async cleanupExpiredKeys() {
    try {
      const result = await db.run(`
        DELETE FROM idempotency_keys
        WHERE expires_at <= datetime('now')
      `);

      log.info('Idempotency keys cleanup completed', { 
        deletedCount: result.changes 
      });

      return result.changes;
    } catch (error) {
      log.error('Failed to cleanup idempotency keys', { error: error.message });
      return 0;
    }
  }

  // Check if key is valid format
  static isValidIdempotencyKey(key) {
    if (!key || typeof key !== 'string') {
      return false;
    }

    // Key should be between 10 and 255 characters
    if (key.length < 10 || key.length > 255) {
      return false;
    }

    // Key should contain only alphanumeric characters, hyphens, and underscores
    return /^[a-zA-Z0-9_-]+$/.test(key);
  }
}

// Middleware to handle idempotency keys
const idempotencyMiddleware = async (req, res, next) => {
  const idempotencyKey = req.headers['idempotency-key'];
  
  // Skip if no idempotency key provided
  if (!idempotencyKey) {
    return next();
  }

  // Validate idempotency key format
  if (!IdempotencyService.isValidIdempotencyKey(idempotencyKey)) {
    return res.status(400).json({
      error: 'Invalid idempotency key format',
      details: 'Idempotency key must be 10-255 characters and contain only letters, numbers, hyphens, and underscores'
    });
  }

  // Skip if user not authenticated
  if (!req.user?.id) {
    return next();
  }

  try {
    // Check for existing result
    const existingResult = await IdempotencyService.getIdempotencyResult(
      idempotencyKey, 
      req.user.id
    );

    if (existingResult) {
      log.info('Idempotency key hit - returning cached result', {
        key: idempotencyKey,
        userId: req.user.id,
        requestId: req.requestId
      });

      return res.json(existingResult);
    }

    // Store idempotency key for this request
    req.idempotencyKey = idempotencyKey;

    // Override res.json to capture and store the response
    const originalJson = res.json;
    res.json = function(data) {
      // Only store successful responses (2xx status codes)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        IdempotencyService.storeIdempotencyResult(
          idempotencyKey,
          req.user.id,
          data
        ).catch(error => {
          log.error('Failed to store idempotency result after response', {
            error: error.message,
            key: idempotencyKey,
            userId: req.user.id
          });
        });
      }

      return originalJson.call(this, data);
    };

    next();

  } catch (error) {
    log.error('Idempotency middleware error', {
      error: error.message,
      key: idempotencyKey,
      userId: req.user?.id
    });
    
    // Continue processing - don't fail request due to idempotency issues
    next();
  }
};

module.exports = {
  IdempotencyService,
  idempotencyMiddleware
};


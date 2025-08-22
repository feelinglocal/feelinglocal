// gdpr-compliance.js - GDPR/CCPA compliance and data privacy controls
const log = require('./logger');
const { AuditService, AUDIT_ACTIONS, RESOURCE_TYPES } = require('./audit');
const { encryptionManager } = require('./encryption');

/**
 * GDPR Compliance Manager
 */
class GDPRComplianceManager {
  constructor() {
    this.dataRetentionPolicies = {
      users: Number(process.env.USER_DATA_RETENTION_DAYS || 2555), // 7 years default
      translations: Number(process.env.TRANSLATION_DATA_RETENTION_DAYS || 365), // 1 year
      logs: Number(process.env.LOG_DATA_RETENTION_DAYS || 90), // 3 months
      sessions: Number(process.env.SESSION_DATA_RETENTION_DAYS || 30), // 1 month
      files: Number(process.env.FILE_DATA_RETENTION_DAYS || 30), // 1 month
      audit: Number(process.env.AUDIT_DATA_RETENTION_DAYS || 2555) // 7 years for compliance
    };
    
    this.consentTypes = {
      necessary: { required: true, description: 'Essential for service functionality' },
      functional: { required: false, description: 'Enhance user experience' },
      analytics: { required: false, description: 'Help us improve our service' },
      marketing: { required: false, description: 'Personalized content and offers' }
    };
    
    this.dataCategories = {
      personal: ['email', 'name', 'phone', 'address'],
      technical: ['ip_address', 'user_agent', 'session_id'],
      usage: ['translations', 'files_uploaded', 'login_history'],
      preferences: ['language', 'settings', 'theme']
    };
  }

  /**
   * Record user consent
   */
  async recordConsent(userId, consentData, ipAddress) {
    try {
      const db = require('./database');
      
      const consentRecord = {
        userId,
        consentData: JSON.stringify(consentData),
        ipAddress,
        userAgent: consentData.userAgent || '',
        timestamp: new Date().toISOString(),
        version: process.env.PRIVACY_POLICY_VERSION || '1.0'
      };

      const consentId = await db.createConsentRecord(consentRecord);
      
      // Audit log
      await AuditService.log(AUDIT_ACTIONS.CONSENT_RECORDED, 'consent', consentId, {
        userId,
        consentTypes: Object.keys(consentData),
        ipAddress
      });

      log.info('User consent recorded', { 
        userId, 
        consentId, 
        consentTypes: Object.keys(consentData) 
      });

      return consentId;
    } catch (error) {
      log.error('Failed to record consent', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Check user consent status
   */
  async checkConsent(userId, consentType = null) {
    try {
      const db = require('./database');
      const latestConsent = await db.getLatestUserConsent(userId);
      
      if (!latestConsent) {
        return { hasConsent: false, requiresConsent: true };
      }

      const consentData = JSON.parse(latestConsent.consentData);
      
      if (consentType) {
        return {
          hasConsent: !!consentData[consentType],
          consentDate: latestConsent.timestamp,
          version: latestConsent.version
        };
      }

      return {
        hasConsent: true,
        consent: consentData,
        consentDate: latestConsent.timestamp,
        version: latestConsent.version
      };
    } catch (error) {
      log.error('Failed to check consent', { userId, error: error.message });
      return { hasConsent: false, error: error.message };
    }
  }

  /**
   * Export user data (GDPR Article 20 - Data Portability)
   */
  async exportUserData(userId, format = 'json') {
    try {
      const db = require('./database');
      
      // Collect all user data
      const userData = await db.getUserById(userId);
      if (!userData) {
        throw new Error('User not found');
      }

      const exportData = {
        personal: {
          id: userData.id,
          email: userData.email,
          name: userData.name,
          tier: userData.tier,
          createdAt: userData.createdAt,
          lastLogin: userData.lastLogin
        },
        translations: await db.getUserTranslations(userId),
        files: await db.getUserFiles(userId),
        phrasebooks: await db.getUserPhrasebooks(userId),
        settings: await db.getUserSettings(userId),
        consent: await db.getUserConsentHistory(userId),
        audit: await db.getUserAuditLog(userId)
      };

      // Generate export metadata
      const exportMetadata = {
        exportDate: new Date().toISOString(),
        dataSubject: userId,
        format: format,
        categories: Object.keys(exportData),
        recordCount: this.countRecords(exportData),
        version: '1.0'
      };

      // Audit log the export request
      await AuditService.log(AUDIT_ACTIONS.DATA_EXPORTED, 'users', userId, {
        format,
        recordCount: exportMetadata.recordCount,
        ipAddress: exportMetadata.ipAddress
      });

      log.info('User data exported', { 
        userId, 
        format, 
        recordCount: exportMetadata.recordCount 
      });

      return {
        metadata: exportMetadata,
        data: exportData
      };
    } catch (error) {
      log.error('Data export failed', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Delete user data (GDPR Article 17 - Right to Erasure)
   */
  async deleteUserData(userId, options = {}) {
    try {
      const { 
        keepAuditLogs = true, 
        keepAnonymizedData = true,
        reason = 'user_request' 
      } = options;

      const db = require('./database');
      
      // Get user data before deletion for audit
      const userData = await db.getUserById(userId);
      if (!userData) {
        throw new Error('User not found');
      }

      const deletionResults = {
        deleted: [],
        anonymized: [],
        retained: []
      };

      // Delete user files
      const userFiles = await db.getUserFiles(userId);
      for (const file of userFiles) {
        await this.deleteFile(file.path);
        deletionResults.deleted.push(`file:${file.id}`);
      }

      // Delete translations
      await db.deleteUserTranslations(userId);
      deletionResults.deleted.push('translations');

      // Delete phrasebooks
      await db.deleteUserPhrasebooks(userId);
      deletionResults.deleted.push('phrasebooks');

      // Delete sessions
      await db.deleteUserSessions(userId);
      deletionResults.deleted.push('sessions');

      // Handle consent records
      if (keepAuditLogs) {
        await db.anonymizeUserConsent(userId);
        deletionResults.anonymized.push('consent');
      } else {
        await db.deleteUserConsent(userId);
        deletionResults.deleted.push('consent');
      }

      // Handle audit logs
      if (keepAuditLogs) {
        await db.anonymizeUserAuditLogs(userId);
        deletionResults.retained.push('audit_logs');
      } else {
        await db.deleteUserAuditLogs(userId);
        deletionResults.deleted.push('audit_logs');
      }

      // Delete or anonymize user record
      if (keepAnonymizedData) {
        await db.anonymizeUser(userId);
        deletionResults.anonymized.push('user_profile');
      } else {
        await db.deleteUser(userId);
        deletionResults.deleted.push('user_profile');
      }

      // Record deletion audit log
      await AuditService.log(AUDIT_ACTIONS.DATA_DELETED, 'users', userId, {
        reason,
        deletionResults,
        timestamp: new Date().toISOString()
      });

      log.info('User data deletion completed', { 
        userId, 
        reason, 
        deletionResults 
      });

      return {
        success: true,
        deletionId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        results: deletionResults
      };
    } catch (error) {
      log.error('Data deletion failed', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Anonymize user data (GDPR-compliant anonymization)
   */
  async anonymizeUserData(userId) {
    try {
      const db = require('./database');
      
      // Generate anonymous identifier
      const anonymousId = `anon_${encryptionManager.hashForIndex(userId + Date.now())}`;
      
      // Anonymize user record
      await db.updateUser(userId, {
        email: `${anonymousId}@anonymized.local`,
        name: 'Anonymized User',
        phone: null,
        address: null,
        isAnonymized: true,
        anonymizedAt: new Date().toISOString(),
        originalId: encryptionManager.hashForIndex(userId)
      });

      log.info('User data anonymized', { userId, anonymousId });
      
      return { success: true, anonymousId };
    } catch (error) {
      log.error('Data anonymization failed', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get data processing information for transparency
   */
  getDataProcessingInfo() {
    return {
      controller: {
        name: process.env.COMPANY_NAME || 'Localization App',
        address: process.env.COMPANY_ADDRESS || '',
        email: process.env.DPO_EMAIL || process.env.CONTACT_EMAIL || '',
        phone: process.env.CONTACT_PHONE || ''
      },
      purposes: {
        service_provision: 'Provide translation and localization services',
        quality_improvement: 'Improve service quality and user experience',
        security: 'Maintain security and prevent abuse',
        legal_compliance: 'Comply with legal obligations'
      },
      lawfulBasis: {
        service_provision: 'Contract performance (GDPR Art. 6(1)(b))',
        quality_improvement: 'Legitimate interests (GDPR Art. 6(1)(f))',
        security: 'Legitimate interests (GDPR Art. 6(1)(f))',
        legal_compliance: 'Legal obligation (GDPR Art. 6(1)(c))'
      },
      retentionPeriods: this.dataRetentionPolicies,
      dataCategories: this.dataCategories,
      thirdParties: {
        openai: 'Translation processing (Data Processing Agreement in place)',
        cloudProvider: 'Infrastructure hosting (Data Processing Agreement in place)'
      },
      rights: [
        'Access your personal data',
        'Rectify inaccurate data',
        'Erase your data',
        'Restrict processing',
        'Data portability',
        'Object to processing',
        'Withdraw consent'
      ]
    };
  }

  /**
   * Check if data retention period has expired
   */
  isRetentionExpired(createdAt, dataType) {
    const retentionDays = this.dataRetentionPolicies[dataType] || this.dataRetentionPolicies.users;
    const expiryDate = new Date(createdAt);
    expiryDate.setDate(expiryDate.getDate() + retentionDays);
    
    return new Date() > expiryDate;
  }

  /**
   * Clean up expired data
   */
  async cleanupExpiredData() {
    try {
      const db = require('./database');
      const results = {
        users: 0,
        translations: 0,
        files: 0,
        logs: 0
      };

      // Clean up expired translations
      const expiredTranslations = await db.getExpiredTranslations(this.dataRetentionPolicies.translations);
      for (const translation of expiredTranslations) {
        await db.deleteTranslation(translation.id);
        results.translations++;
      }

      // Clean up expired files
      const expiredFiles = await db.getExpiredFiles(this.dataRetentionPolicies.files);
      for (const file of expiredFiles) {
        await this.deleteFile(file.path);
        await db.deleteFile(file.id);
        results.files++;
      }

      // Clean up expired logs
      const expiredLogs = await db.getExpiredLogs(this.dataRetentionPolicies.logs);
      for (const logEntry of expiredLogs) {
        await db.deleteLogEntry(logEntry.id);
        results.logs++;
      }

      log.info('GDPR data cleanup completed', { results });
      
      return results;
    } catch (error) {
      log.error('GDPR data cleanup failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Generate privacy policy compliance report
   */
  async generateComplianceReport() {
    try {
      const db = require('./database');
      
      const report = {
        reportDate: new Date().toISOString(),
        dataProcessing: this.getDataProcessingInfo(),
        statistics: {
          totalUsers: await db.getUserCount(),
          activeUsers: await db.getActiveUserCount(30), // Last 30 days
          consentRecords: await db.getConsentRecordCount(),
          dataExports: await db.getDataExportCount(),
          deletionRequests: await db.getDeletionRequestCount()
        },
        retentionCompliance: {
          policies: this.dataRetentionPolicies,
          nextCleanup: this.getNextCleanupDate()
        },
        security: {
          encryptionEnabled: true,
          auditLogging: true,
          accessControls: true
        }
      };

      return report;
    } catch (error) {
      log.error('Failed to generate compliance report', { error: error.message });
      throw error;
    }
  }

  /**
   * Delete file securely
   */
  async deleteFile(filePath) {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      
      if (await fs.access(filePath).then(() => true).catch(() => false)) {
        // Overwrite file with random data before deletion (secure deletion)
        const stats = await fs.stat(filePath);
        const randomData = crypto.randomBytes(stats.size);
        
        await fs.writeFile(filePath, randomData);
        await fs.unlink(filePath);
        
        log.debug('File securely deleted', { filePath });
      }
    } catch (error) {
      log.warn('File deletion failed', { filePath, error: error.message });
    }
  }

  /**
   * Get next cleanup date
   */
  getNextCleanupDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 0, 0, 0); // 2 AM
    return tomorrow.toISOString();
  }

  /**
   * Count records in export data
   */
  countRecords(exportData) {
    let count = 0;
    for (const category of Object.values(exportData)) {
      if (Array.isArray(category)) {
        count += category.length;
      } else if (typeof category === 'object' && category !== null) {
        count += Object.keys(category).length;
      } else {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Validate consent request
   */
  validateConsentRequest(consentData) {
    const errors = [];
    
    // Check required consent types
    for (const [type, config] of Object.entries(this.consentTypes)) {
      if (config.required && !consentData[type]) {
        errors.push(`Required consent '${type}' not provided`);
      }
    }

    // Check for unknown consent types
    for (const type of Object.keys(consentData)) {
      if (!this.consentTypes[type]) {
        errors.push(`Unknown consent type '${type}'`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Health check for GDPR compliance system
   */
  healthCheck() {
    return {
      status: 'healthy',
      retentionPolicies: Object.keys(this.dataRetentionPolicies).length,
      consentTypes: Object.keys(this.consentTypes).length,
      dataCategories: Object.keys(this.dataCategories).length,
      encryptionAvailable: encryptionManager.healthCheck().status === 'healthy',
      auditingEnabled: true
    };
  }
}

// Global GDPR manager instance
const gdprManager = new GDPRComplianceManager();

/**
 * Middleware to check GDPR consent
 */
function gdprConsentMiddleware(req, res, next) {
  // Skip for health checks and auth endpoints
  if (req.path.startsWith('/api/health') || req.path.startsWith('/auth/')) {
    return next();
  }

  // Skip for non-authenticated requests
  if (!req.user) {
    return next();
  }

  req.gdpr = {
    recordConsent: (consentData) => gdprManager.recordConsent(req.user.id, consentData, req.ip),
    checkConsent: (type) => gdprManager.checkConsent(req.user.id, type),
    exportData: (format) => gdprManager.exportUserData(req.user.id, format),
    deleteData: (options) => gdprManager.deleteUserData(req.user.id, options),
    getProcessingInfo: () => gdprManager.getDataProcessingInfo(),
    healthCheck: () => gdprManager.healthCheck()
  };

  next();
}

/**
 * Require specific consent type
 */
function requireConsent(consentType) {
  return async (req, res, next) => {
    if (!req.user) {
      return next();
    }

    try {
      const consent = await gdprManager.checkConsent(req.user.id, consentType);
      
      if (!consent.hasConsent) {
        return res.status(403).json({
          error: 'Consent required',
          consentType,
          description: gdprManager.consentTypes[consentType]?.description,
          consentUrl: '/privacy/consent'
        });
      }

      next();
    } catch (error) {
      log.error('Consent check failed', { userId: req.user.id, consentType, error: error.message });
      next(); // Allow request to proceed on consent check failure
    }
  };
}

/**
 * Schedule automatic data cleanup
 */
function scheduleGDPRCleanup() {
  const cron = require('cron');
  
  // Daily cleanup at 2 AM
  const cleanupJob = new cron.CronJob('0 2 * * *', async () => {
    try {
      log.info('Starting scheduled GDPR data cleanup');
      await gdprManager.cleanupExpiredData();
      log.info('Scheduled GDPR data cleanup completed');
    } catch (error) {
      log.error('Scheduled GDPR cleanup failed', { error: error.message });
    }
  });

  cleanupJob.start();
  log.info('GDPR cleanup scheduled', { schedule: '0 2 * * *' });
}

module.exports = {
  GDPRComplianceManager,
  gdprManager,
  gdprConsentMiddleware,
  requireConsent,
  scheduleGDPRCleanup
};

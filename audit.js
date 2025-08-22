// audit.js - Audit logging service
const db = require('./database');
const log = require('./logger');

class AuditService {
  // Log an audit event
  static async logEvent(userId, action, resourceType, resourceId = null, details = {}, req = null) {
    try {
      const auditData = {
        user_id: userId,
        action,
        resource_type: resourceType,
        resource_id: resourceId ? resourceId.toString() : null,
        details: JSON.stringify(details),
        ip_address: req?.ip || null,
        user_agent: req?.get('User-Agent') || null,
        request_id: req?.requestId || null
      };

      await db.run(`
        INSERT INTO audit_logs 
        (user_id, action, resource_type, resource_id, details, ip_address, user_agent, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        auditData.user_id,
        auditData.action,
        auditData.resource_type,
        auditData.resource_id,
        auditData.details,
        auditData.ip_address,
        auditData.user_agent,
        auditData.request_id
      ]);

      log.info('Audit event logged', {
        userId,
        action,
        resourceType,
        resourceId,
        requestId: req?.requestId
      });

    } catch (error) {
      log.error('Failed to log audit event', {
        error: error.message,
        userId,
        action,
        resourceType
      });
    }
  }

  // Get audit logs for a user
  static async getUserAuditLogs(userId, limit = 100, offset = 0) {
    try {
      const logs = await db.all(`
        SELECT 
          action,
          resource_type,
          resource_id,
          details,
          ip_address,
          created_at
        FROM audit_logs 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `, [userId, limit, offset]);

      return logs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : {}
      }));
    } catch (error) {
      log.error('Failed to get user audit logs', { error: error.message, userId });
      return [];
    }
  }

  // Get audit logs for a resource
  static async getResourceAuditLogs(resourceType, resourceId, limit = 50) {
    try {
      const logs = await db.all(`
        SELECT 
          user_id,
          action,
          details,
          ip_address,
          created_at
        FROM audit_logs 
        WHERE resource_type = ? AND resource_id = ?
        ORDER BY created_at DESC 
        LIMIT ?
      `, [resourceType, resourceId.toString(), limit]);

      return logs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : {}
      }));
    } catch (error) {
      log.error('Failed to get resource audit logs', { 
        error: error.message, 
        resourceType, 
        resourceId 
      });
      return [];
    }
  }

  // Clean up old audit logs (retention policy)
  static async cleanupOldLogs(retentionDays = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const result = await db.run(`
        DELETE FROM audit_logs 
        WHERE created_at < ?
      `, [cutoffDate.toISOString()]);

      log.info('Audit logs cleanup completed', {
        retentionDays,
        deletedCount: result.changes
      });

      return result.changes;
    } catch (error) {
      log.error('Failed to cleanup audit logs', { error: error.message });
      return 0;
    }
  }
}

// Audit event constants
const AUDIT_ACTIONS = {
  // User actions
  USER_REGISTER: 'user.register',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',

  // API Key actions
  API_KEY_CREATE: 'api_key.create',
  API_KEY_DELETE: 'api_key.delete',
  API_KEY_USE: 'api_key.use',

  // File actions
  FILE_UPLOAD: 'file.upload',
  FILE_DOWNLOAD: 'file.download',
  FILE_DELETE: 'file.delete',
  FILE_EXPIRE: 'file.expire',

  // Translation actions
  TRANSLATE_SINGLE: 'translate.single',
  TRANSLATE_BATCH: 'translate.batch',

  // Phrasebook actions
  PHRASEBOOK_CREATE: 'phrasebook.create',
  PHRASEBOOK_READ: 'phrasebook.read',
  PHRASEBOOK_UPDATE: 'phrasebook.update',
  PHRASEBOOK_DELETE: 'phrasebook.delete',

  // Organization actions
  ORG_CREATE: 'org.create',
  ORG_JOIN: 'org.join',
  ORG_LEAVE: 'org.leave',
  ORG_UPDATE: 'org.update'
};

const RESOURCE_TYPES = {
  USER: 'user',
  API_KEY: 'api_key',
  FILE: 'file',
  PHRASEBOOK: 'phrasebook',
  ORGANIZATION: 'org',
  TRANSLATION: 'translation'
};

module.exports = {
  AuditService,
  AUDIT_ACTIONS,
  RESOURCE_TYPES
};


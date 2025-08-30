// advanced-audit.js - Advanced audit trails with tamper-proof logging
const crypto = require('crypto');
const log = require('./logger');
const { encryptionManager } = require('./encryption');

/**
 * Advanced Audit System with tamper-proof logging
 */
class AdvancedAuditManager {
  constructor() {
    this.db = require('./database');
    this.chainHash = null; // Blockchain-style hash chain
    this.initialized = false;
    this.config = {
      enableTamperProof: process.env.AUDIT_TAMPER_PROOF !== 'false',
      enableEncryption: process.env.AUDIT_ENCRYPTION !== 'false',
      retentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 2555), // 7 years
      enableRealTimeVerification: process.env.AUDIT_REAL_TIME_VERIFY === 'true',
      hashAlgorithm: 'sha256'
    };
    
    this.stats = {
      logsCreated: 0,
      verificationsPerformed: 0,
      tamperAttempts: 0,
      chainVerifications: 0
    };
  }

  /**
   * Initialize advanced audit system
   */
  async init() {
    try {
      // Ensure database is initialized first
      if (!this.db.instance) {
        await this.db.init();
      }
      
      await this.createAdvancedAuditTables();
      await this.initializeHashChain();
      
      this.initialized = true;
      
      log.info('Advanced audit system initialized', {
        tamperProof: this.config.enableTamperProof,
        encryption: this.config.enableEncryption
      });
    } catch (error) {
      log.error('Failed to initialize advanced audit system', { error: error.message });
      throw error;
    }
  }

  /**
   * Create advanced audit tables
   */
  async createAdvancedAuditTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS audit_logs_advanced (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_index INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        details TEXT, -- JSON details
        details_hash TEXT NOT NULL,
        previous_hash TEXT,
        current_hash TEXT NOT NULL,
        signature TEXT,
        encrypted_data TEXT,
        verification_status TEXT DEFAULT 'unverified',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS audit_chain_state (
        id INTEGER PRIMARY KEY,
        last_index INTEGER NOT NULL,
        last_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS audit_integrity_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_type TEXT NOT NULL,
        start_index INTEGER NOT NULL,
        end_index INTEGER NOT NULL,
        expected_hash TEXT NOT NULL,
        actual_hash TEXT NOT NULL,
        status TEXT NOT NULL, -- 'passed', 'failed', 'warning'
        issues_found TEXT, -- JSON array of issues
        performed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        performed_by TEXT
      )`,
      
      // Create indexes separately
      `CREATE INDEX IF NOT EXISTS idx_audit_chain ON audit_logs_advanced (chain_index)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_hash ON audit_logs_advanced (current_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs_advanced (timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs_advanced (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs_advanced (resource_type, resource_id)`
    ];

    for (const query of queries) {
      await this.db.run(query);
    }
  }

  /**
   * Initialize hash chain for tamper-proof logging
   */
  async initializeHashChain() {
    try {
      const chainState = await this.db.get('SELECT * FROM audit_chain_state WHERE id = 1');
      
      if (chainState) {
        this.chainHash = chainState.last_hash;
        log.info('Hash chain restored', { 
          lastIndex: chainState.last_index,
          lastHash: chainState.last_hash.substring(0, 16) + '...'
        });
      } else {
        // Initialize new chain
        const genesisHash = crypto.createHash(this.config.hashAlgorithm)
          .update('genesis_block_' + Date.now())
          .digest('hex');
        
        this.chainHash = genesisHash;
        
        await this.db.run(
          'INSERT INTO audit_chain_state (id, last_index, last_hash) VALUES (1, 0, ?)',
          [genesisHash]
        );
        
        log.info('New hash chain initialized', { genesisHash: genesisHash.substring(0, 16) + '...' });
      }
    } catch (error) {
      log.error('Failed to initialize hash chain', { error: error.message });
      throw error;
    }
  }

  /**
   * Create tamper-proof audit log entry
   */
  async createAuditLog(action, resourceType, resourceId, details = {}, userId = null, sessionInfo = {}) {
    if (!this.initialized) {
      log.warn('Advanced audit system not initialized, skipping audit log');
      return null;
    }
    
    try {
      const timestamp = new Date().toISOString();
      const chainIndex = await this.getNextChainIndex();
      
      // Prepare audit data
      const auditData = {
        action,
        resourceType,
        resourceId,
        userId,
        timestamp,
        sessionId: sessionInfo.sessionId,
        ipAddress: sessionInfo.ipAddress,
        userAgent: sessionInfo.userAgent,
        details
      };

      // Create hash of the details
      const detailsJson = JSON.stringify(details);
      const detailsHash = crypto.createHash(this.config.hashAlgorithm)
        .update(detailsJson)
        .digest('hex');

      // Create chain hash (includes previous hash for tamper-proofing)
      const chainContent = [
        chainIndex,
        timestamp,
        action,
        resourceType,
        resourceId,
        userId || '',
        detailsHash,
        this.chainHash || ''
      ].join('::');

      const currentHash = crypto.createHash(this.config.hashAlgorithm)
        .update(chainContent)
        .digest('hex');

      // Encrypt sensitive data if enabled
      let encryptedData = null;
      if (this.config.enableEncryption) {
        const sensitiveData = {
          details,
          userAgent: sessionInfo.userAgent,
          ipAddress: sessionInfo.ipAddress
        };
        encryptedData = encryptionManager.encryptFile(JSON.stringify(sensitiveData), {
          auditId: chainIndex,
          timestamp
        });
      }

      // Create digital signature
      const signature = this.createSignature(currentHash);

      // Insert audit log
      const auditId = await this.db.run(
        `INSERT INTO audit_logs_advanced 
         (chain_index, timestamp, action, resource_type, resource_id, user_id, 
          session_id, ip_address, user_agent, details, details_hash, 
          previous_hash, current_hash, signature, encrypted_data) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chainIndex,
          timestamp,
          action,
          resourceType,
          resourceId,
          userId,
          sessionInfo.sessionId,
          sessionInfo.ipAddress,
          sessionInfo.userAgent,
          detailsJson,
          detailsHash,
          this.chainHash,
          currentHash,
          signature,
          encryptedData ? JSON.stringify(encryptedData) : null
        ]
      );

      // Update chain state
      await this.updateChainState(chainIndex, currentHash);
      this.chainHash = currentHash;

      this.stats.logsCreated++;
      
      log.debug('Tamper-proof audit log created', {
        auditId: auditId.lastID,
        chainIndex,
        action,
        resourceType,
        hashPreview: currentHash.substring(0, 16) + '...'
      });

      // Real-time verification if enabled
      if (this.config.enableRealTimeVerification) {
        setTimeout(() => this.verifyLogIntegrity(auditId.lastID), 1000);
      }

      return auditId.lastID;
      
    } catch (error) {
      log.error('Failed to create tamper-proof audit log', { error: error.message });
      throw error;
    }
  }

  /**
   * Get next chain index
   */
  async getNextChainIndex() {
    const result = await this.db.get('SELECT last_index FROM audit_chain_state WHERE id = 1');
    return (result?.last_index || 0) + 1;
  }

  /**
   * Update chain state
   */
  async updateChainState(index, hash) {
    await this.db.run(
      'UPDATE audit_chain_state SET last_index = ?, last_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [index, hash]
    );
  }

  /**
   * Create digital signature for hash
   */
  createSignature(hash) {
    const key = process.env.AUDIT_SIGNING_KEY || 'default_audit_key';
    return crypto.createHmac('sha256', key).update(hash).digest('hex');
  }

  /**
   * Verify log integrity
   */
  async verifyLogIntegrity(auditId) {
    try {
      const auditLog = await this.db.get(
        'SELECT * FROM audit_logs_advanced WHERE id = ?',
        [auditId]
      );

      if (!auditLog) {
        throw new Error('Audit log not found');
      }

      // Verify details hash
      const detailsHash = crypto.createHash(this.config.hashAlgorithm)
        .update(auditLog.details)
        .digest('hex');
        
      if (detailsHash !== auditLog.details_hash) {
        throw new Error('Details hash mismatch - possible tampering');
      }

      // Verify chain hash
      const chainContent = [
        auditLog.chain_index,
        auditLog.timestamp,
        auditLog.action,
        auditLog.resource_type,
        auditLog.resource_id,
        auditLog.user_id || '',
        auditLog.details_hash,
        auditLog.previous_hash || ''
      ].join('::');

      const expectedHash = crypto.createHash(this.config.hashAlgorithm)
        .update(chainContent)
        .digest('hex');

      if (expectedHash !== auditLog.current_hash) {
        throw new Error('Chain hash mismatch - possible tampering');
      }

      // Verify signature
      const expectedSignature = this.createSignature(auditLog.current_hash);
      if (expectedSignature !== auditLog.signature) {
        throw new Error('Signature mismatch - possible tampering');
      }

      // Update verification status
      await this.db.run(
        'UPDATE audit_logs_advanced SET verification_status = ? WHERE id = ?',
        ['verified', auditId]
      );

      this.stats.verificationsPerformed++;
      
      return { verified: true, auditId };
      
    } catch (error) {
      this.stats.tamperAttempts++;
      
      // Mark as potentially tampered
      await this.db.run(
        'UPDATE audit_logs_advanced SET verification_status = ? WHERE id = ?',
        ['tampered', auditId]
      );

      log.error('Audit log integrity verification failed', { 
        auditId, 
        error: error.message 
      });

      // Trigger alert for potential tampering
      await this.triggerTamperAlert(auditId, error.message);
      
      throw error;
    }
  }

  /**
   * Verify entire audit chain integrity
   */
  async verifyChainIntegrity(startIndex = 1, endIndex = null) {
    try {
      const endIdx = endIndex || await this.getLastChainIndex();
      
      log.info('Starting audit chain verification', { startIndex, endIndex: endIdx });
      
      let previousHash = null;
      const issues = [];
      
      for (let i = startIndex; i <= endIdx; i++) {
        const auditLog = await this.db.get(
          'SELECT * FROM audit_logs_advanced WHERE chain_index = ?',
          [i]
        );

        if (!auditLog) {
          issues.push({ index: i, issue: 'Missing audit log entry' });
          continue;
        }

        // Verify against previous hash
        if (previousHash && auditLog.previous_hash !== previousHash) {
          issues.push({ 
            index: i, 
            issue: 'Previous hash mismatch',
            expected: previousHash,
            actual: auditLog.previous_hash
          });
        }

        // Verify individual log integrity
        try {
          await this.verifyLogIntegrity(auditLog.id);
        } catch (verifyError) {
          issues.push({ 
            index: i, 
            issue: 'Log integrity verification failed',
            error: verifyError.message
          });
        }

        previousHash = auditLog.current_hash;
      }

      // Store verification results
      await this.db.run(
        `INSERT INTO audit_integrity_checks 
         (check_type, start_index, end_index, expected_hash, actual_hash, status, issues_found) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          'chain_verification',
          startIndex,
          endIdx,
          previousHash || '',
          this.chainHash || '',
          issues.length === 0 ? 'passed' : 'failed',
          JSON.stringify(issues)
        ]
      );

      this.stats.chainVerifications++;

      log.info('Audit chain verification completed', {
        startIndex,
        endIndex: endIdx,
        issues: issues.length,
        status: issues.length === 0 ? 'passed' : 'failed'
      });

      return {
        verified: issues.length === 0,
        issues,
        range: { start: startIndex, end: endIdx },
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      log.error('Chain verification failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get last chain index
   */
  async getLastChainIndex() {
    const result = await this.db.get('SELECT last_index FROM audit_chain_state WHERE id = 1');
    return result?.last_index || 0;
  }

  /**
   * Trigger tamper alert
   */
  async triggerTamperAlert(auditId, issue) {
    try {
      // Log critical security event
      log.error('SECURITY ALERT: Audit log tampering detected', {
        auditId,
        issue,
        timestamp: new Date().toISOString(),
        severity: 'CRITICAL'
      });

      // Send real-time notification if WebSocket is available
      try {
        const { webSocketManager } = require('./websocket');
        webSocketManager.io?.of('/admin').emit('security_alert', {
          type: 'audit_tampering',
          auditId,
          issue,
          severity: 'critical',
          timestamp: Date.now()
        });
      } catch (wsError) {
        log.debug('Could not send WebSocket alert', { error: wsError.message });
      }

      // Store alert in database
      await this.db.run(
        `INSERT INTO security_alerts (type, severity, details, created_at) 
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        ['audit_tampering', 'critical', JSON.stringify({ auditId, issue })]
      );

    } catch (error) {
      log.error('Failed to trigger tamper alert', { error: error.message });
    }
  }

  /**
   * Search audit logs with advanced filtering
   */
  async searchAuditLogs(filters = {}) {
    try {
      let whereClause = '1=1';
      const params = [];

      if (filters.action) {
        whereClause += ' AND action = ?';
        params.push(filters.action);
      }

      if (filters.userId) {
        whereClause += ' AND user_id = ?';
        params.push(filters.userId);
      }

      if (filters.resourceType) {
        whereClause += ' AND resource_type = ?';
        params.push(filters.resourceType);
      }

      if (filters.startDate) {
        whereClause += ' AND timestamp >= ?';
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        whereClause += ' AND timestamp <= ?';
        params.push(filters.endDate);
      }

      if (filters.ipAddress) {
        whereClause += ' AND ip_address = ?';
        params.push(filters.ipAddress);
      }

      if (filters.verificationStatus) {
        whereClause += ' AND verification_status = ?';
        params.push(filters.verificationStatus);
      }

      const offset = filters.offset || 0;
      const limit = Math.min(filters.limit || 100, 1000); // Max 1000 records

      const logs = await this.db.all(
        `SELECT id, chain_index, timestamp, action, resource_type, resource_id, 
                user_id, ip_address, details, verification_status, created_at
         FROM audit_logs_advanced 
         WHERE ${whereClause}
         ORDER BY chain_index DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const totalCount = await this.db.get(
        `SELECT COUNT(*) as count FROM audit_logs_advanced WHERE ${whereClause}`,
        params
      );

      return {
        logs: logs.map(log => ({
          ...log,
          details: JSON.parse(log.details || '{}')
        })),
        total: totalCount.count,
        offset,
        limit
      };
      
    } catch (error) {
      log.error('Audit log search failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Generate audit trail report
   */
  async generateAuditReport(filters = {}) {
    try {
      const searchResults = await this.searchAuditLogs(filters);
      
      // Generate summary statistics
      const summary = await this.db.get(`
        SELECT 
          COUNT(*) as total_entries,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT action) as unique_actions,
          MIN(timestamp) as earliest_entry,
          MAX(timestamp) as latest_entry
        FROM audit_logs_advanced
        WHERE timestamp >= ? AND timestamp <= ?
      `, [
        filters.startDate || '1970-01-01',
        filters.endDate || new Date().toISOString()
      ]);

      // Get action breakdown
      const actionBreakdown = await this.db.all(`
        SELECT action, COUNT(*) as count
        FROM audit_logs_advanced
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY action
        ORDER BY count DESC
      `, [
        filters.startDate || '1970-01-01',
        filters.endDate || new Date().toISOString()
      ]);

      // Get verification status
      const verificationStatus = await this.db.all(`
        SELECT verification_status, COUNT(*) as count
        FROM audit_logs_advanced
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY verification_status
      `, [
        filters.startDate || '1970-01-01',
        filters.endDate || new Date().toISOString()
      ]);

      return {
        reportId: crypto.randomUUID(),
        generatedAt: new Date().toISOString(),
        period: {
          start: filters.startDate || summary.earliest_entry,
          end: filters.endDate || summary.latest_entry
        },
        summary,
        actionBreakdown,
        verificationStatus,
        logs: searchResults.logs,
        metadata: {
          totalPages: Math.ceil(searchResults.total / (filters.limit || 100)),
          currentPage: Math.floor((filters.offset || 0) / (filters.limit || 100)) + 1
        }
      };
      
    } catch (error) {
      log.error('Audit report generation failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Export audit logs for compliance
   */
  async exportAuditLogs(format = 'json', filters = {}) {
    try {
      const auditData = await this.generateAuditReport(filters);
      
      switch (format.toLowerCase()) {
        case 'csv':
          return this.exportToCSV(auditData);
        case 'xml':
          return this.exportToXML(auditData);
        default:
          return auditData;
      }
    } catch (error) {
      log.error('Audit export failed', { format, error: error.message });
      throw error;
    }
  }

  /**
   * Export to CSV format
   */
  exportToCSV(auditData) {
    const headers = [
      'ID', 'Chain Index', 'Timestamp', 'Action', 'Resource Type', 
      'Resource ID', 'User ID', 'IP Address', 'Verification Status'
    ];
    
    let csv = headers.join(',') + '\n';
    
    for (const log of auditData.logs) {
      const row = [
        log.id,
        log.chain_index,
        log.timestamp,
        log.action,
        log.resource_type,
        log.resource_id,
        log.user_id || '',
        log.ip_address || '',
        log.verification_status
      ].map(field => `"${String(field).replace(/"/g, '""')}"`);
      
      csv += row.join(',') + '\n';
    }
    
    return csv;
  }

  /**
   * Health check for audit system
   */
  async healthCheck() {
    try {
      const chainState = await this.db.get('SELECT * FROM audit_chain_state WHERE id = 1');
      const recentLogs = await this.db.get(
        'SELECT COUNT(*) as count FROM audit_logs_advanced WHERE created_at > datetime("now", "-1 hour")'
      );
      
      // Check for any tampered logs
      const tamperedLogs = await this.db.get(
        'SELECT COUNT(*) as count FROM audit_logs_advanced WHERE verification_status = "tampered"'
      );

      return {
        status: tamperedLogs.count === 0 ? 'healthy' : 'compromised',
        chainState: {
          lastIndex: chainState?.last_index || 0,
          lastHash: chainState?.last_hash?.substring(0, 16) + '...'
        },
        recentActivity: recentLogs.count,
        tamperedLogs: tamperedLogs.count,
        stats: this.stats,
        config: {
          tamperProofEnabled: this.config.enableTamperProof,
          encryptionEnabled: this.config.enableEncryption,
          realTimeVerification: this.config.enableRealTimeVerification
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  /**
   * Get audit statistics
   */
  async getAuditStatistics() {
    try {
      const stats = await this.db.get(`
        SELECT 
          COUNT(*) as total_logs,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT action) as unique_actions,
          MIN(timestamp) as first_log,
          MAX(timestamp) as last_log
        FROM audit_logs_advanced
      `);

      return {
        ...stats,
        runtime: this.stats
      };
    } catch (error) {
      log.error('Failed to get audit statistics', { error: error.message });
      return { error: error.message };
    }
  }
}

// Global advanced audit manager
const advancedAuditManager = new AdvancedAuditManager();

/**
 * Middleware to create tamper-proof audit logs automatically
 */
function advancedAuditMiddleware(req, res, next) {
  const originalJson = res.json;
  const startTime = Date.now();

  res.json = function(data) {
    // Create audit log for API responses
    if (req.user && req.method !== 'GET') {
      const sessionInfo = {
        sessionId: req.sessionID,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      };

      const auditDetails = {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: Date.now() - startTime,
        responseSize: JSON.stringify(data).length,
        requestId: req.requestId
      };

      // Create audit log asynchronously
      advancedAuditManager.createAuditLog(
        'api_call',
        'http_request',
        req.requestId || `${req.method}:${req.path}`,
        auditDetails,
        req.user.id,
        sessionInfo
      ).catch(error => {
        log.error('Failed to create audit log', { error: error.message });
      });
    }

    return originalJson.call(this, data);
  };

  next();
}

module.exports = {
  AdvancedAuditManager,
  advancedAuditManager,
  advancedAuditMiddleware
};



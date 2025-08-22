// backup.js - Database backup and lifecycle management
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const cron = require('cron');
const log = require('./logger');
const { storageService } = require('./storage');

class BackupService {
  constructor() {
    this.dbPath = path.join(__dirname, 'app.db');
    this.backupDir = path.join(__dirname, 'backups');
    this.retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || '30');
  }

  // Create database backup
  async createDatabaseBackup() {
    try {
      // Ensure backup directory exists
      await fs.mkdir(this.backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFilename = `backup_${timestamp}.db`;
      const backupPath = path.join(this.backupDir, backupFilename);

      // Create backup using SQLite backup command
      if (process.platform === 'win32') {
        // Windows: copy file directly (SQLite allows this when using WAL mode)
        await fs.copyFile(this.dbPath, backupPath);
      } else {
        // Unix: use SQLite backup command
        const command = `sqlite3 ${this.dbPath} ".backup ${backupPath}"`;
        await execAsync(command);
      }

      const stats = await fs.stat(backupPath);
      
      log.info('Database backup created', {
        filename: backupFilename,
        size: stats.size,
        path: backupPath
      });

      // Upload to S3 if configured
      if (storageService.enabled) {
        try {
          const backupBuffer = await fs.readFile(backupPath);
          const s3Key = `backups/database/${backupFilename}`;
          
          await storageService.uploadFile(backupBuffer, s3Key, {
            type: 'backup',
            ttl: '30d',
            backupDate: new Date().toISOString()
          });

          log.info('Database backup uploaded to S3', { s3Key });
        } catch (s3Error) {
          log.error('Failed to upload backup to S3', { error: s3Error.message });
        }
      }

      return {
        filename: backupFilename,
        path: backupPath,
        size: stats.size
      };

    } catch (error) {
      log.error('Database backup failed', { error: error.message });
      throw error;
    }
  }

  // Clean up old backups
  async cleanupOldBackups() {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupFiles = files.filter(f => f.startsWith('backup_') && f.endsWith('.db'));

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      let deletedCount = 0;

      for (const filename of backupFiles) {
        try {
          const filePath = path.join(this.backupDir, filename);
          const stats = await fs.stat(filePath);

          if (stats.mtime < cutoffDate) {
            await fs.unlink(filePath);
            deletedCount++;
            
            log.info('Old backup deleted', {
              filename,
              age: Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24))
            });
          }
        } catch (fileError) {
          log.error('Failed to process backup file', {
            filename,
            error: fileError.message
          });
        }
      }

      log.info('Backup cleanup completed', {
        deletedCount,
        retentionDays: this.retentionDays
      });

      return deletedCount;

    } catch (error) {
      log.error('Backup cleanup failed', { error: error.message });
      return 0;
    }
  }

  // Schedule daily backups
  scheduleBackups() {
    // Run daily at 2 AM
    const backupJob = new cron.CronJob('0 2 * * *', async () => {
      try {
        await this.createDatabaseBackup();
        await this.cleanupOldBackups();
      } catch (error) {
        log.error('Scheduled backup failed', { error: error.message });
      }
    }, null, true, 'UTC');

    log.info('Database backup scheduled', { 
      pattern: '0 2 * * *',
      retentionDays: this.retentionDays
    });

    return backupJob;
  }

  // Restore from backup
  async restoreFromBackup(backupFilename) {
    try {
      const backupPath = path.join(this.backupDir, backupFilename);
      
      // Verify backup file exists
      await fs.access(backupPath);

      // Create a backup of current database before restore
      const currentBackupName = `pre_restore_${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      const currentBackupPath = path.join(this.backupDir, currentBackupName);
      await fs.copyFile(this.dbPath, currentBackupPath);

      // Restore from backup
      await fs.copyFile(backupPath, this.dbPath);

      log.info('Database restored from backup', {
        backupFilename,
        currentBackupSaved: currentBackupName
      });

      return true;

    } catch (error) {
      log.error('Database restore failed', {
        backupFilename,
        error: error.message
      });
      throw error;
    }
  }

  // List available backups
  async listBackups() {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupFiles = files.filter(f => f.startsWith('backup_') && f.endsWith('.db'));

      const backups = [];
      for (const filename of backupFiles) {
        try {
          const filePath = path.join(this.backupDir, filename);
          const stats = await fs.stat(filePath);
          
          backups.push({
            filename,
            size: stats.size,
            created: stats.mtime.toISOString(),
            age: Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24))
          });
        } catch (fileError) {
          log.error('Failed to get backup file stats', {
            filename,
            error: fileError.message
          });
        }
      }

      // Sort by creation date (newest first)
      backups.sort((a, b) => new Date(b.created) - new Date(a.created));

      return backups;

    } catch (error) {
      log.error('Failed to list backups', { error: error.message });
      return [];
    }
  }
}

// File retention service for S3 and local files
class FileRetentionService {
  constructor() {
    this.defaultTtlHours = parseInt(process.env.DEFAULT_FILE_TTL_HOURS || '24');
  }

  // Mark files as expired
  async markExpiredFiles() {
    try {
      const db = require('./database');
      
      const result = await db.run(`
        UPDATE files 
        SET status = 'expired'
        WHERE status = 'active' 
        AND expires_at IS NOT NULL 
        AND expires_at < datetime('now')
      `);

      log.info('Files marked as expired', { count: result.changes });
      return result.changes;

    } catch (error) {
      log.error('Failed to mark expired files', { error: error.message });
      return 0;
    }
  }

  // Clean up expired files from S3 and database
  async cleanupExpiredFiles() {
    try {
      const db = require('./database');
      
      // Get expired files
      const expiredFiles = await db.all(`
        SELECT id, s3_key, user_id, original_name
        FROM files 
        WHERE status = 'expired'
        LIMIT 100
      `);

      let deletedCount = 0;
      let errorCount = 0;

      for (const file of expiredFiles) {
        try {
          // Delete from S3 if configured
          if (storageService.enabled && file.s3_key) {
            await storageService.deleteFile(file.s3_key);
          }

          // Mark as deleted in database
          await db.run(`
            UPDATE files 
            SET status = 'deleted'
            WHERE id = ?
          `, [file.id]);

          // Log audit event
          const { AuditService, AUDIT_ACTIONS, RESOURCE_TYPES } = require('./audit');
          await AuditService.logEvent(
            file.user_id,
            AUDIT_ACTIONS.FILE_EXPIRE,
            RESOURCE_TYPES.FILE,
            file.id,
            { originalName: file.original_name, s3Key: file.s3_key }
          );

          deletedCount++;

        } catch (fileError) {
          errorCount++;
          log.error('Failed to cleanup expired file', {
            fileId: file.id,
            s3Key: file.s3_key,
            error: fileError.message
          });
        }
      }

      log.info('Expired files cleanup completed', {
        deletedCount,
        errorCount,
        totalProcessed: expiredFiles.length
      });

      return { deletedCount, errorCount };

    } catch (error) {
      log.error('Failed to cleanup expired files', { error: error.message });
      return { deletedCount: 0, errorCount: 0 };
    }
  }

  // Schedule retention jobs
  scheduleRetentionJobs() {
    // Mark expired files every hour
    const markExpiredJob = new cron.CronJob('0 * * * *', async () => {
      await this.markExpiredFiles();
    }, null, true, 'UTC');

    // Clean up expired files every 6 hours
    const cleanupJob = new cron.CronJob('0 */6 * * *', async () => {
      await this.cleanupExpiredFiles();
    }, null, true, 'UTC');

    log.info('File retention jobs scheduled', {
      markExpiredPattern: '0 * * * *',
      cleanupPattern: '0 */6 * * *',
      defaultTtlHours: this.defaultTtlHours
    });

    return { markExpiredJob, cleanupJob };
  }
}

module.exports = {
  BackupService,
  FileRetentionService
};


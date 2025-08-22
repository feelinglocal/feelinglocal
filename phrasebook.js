// phrasebook.js - Database-backed phrasebook service (migrated from JSON files)
const db = require('./database');
const log = require('./logger');
const { AuditService, AUDIT_ACTIONS, RESOURCE_TYPES } = require('./audit');
const fs = require('fs').promises;
const path = require('path');

class PhrasebookService {
  // Create a new phrasebook
  static async createPhrasebook(userId, name = 'My Phrasebook', data = [], req = null) {
    try {
      const result = await db.run(`
        INSERT INTO phrasebooks (user_id, name, data)
        VALUES (?, ?, ?)
      `, [userId, name, JSON.stringify(data)]);

      await AuditService.logEvent(
        userId,
        AUDIT_ACTIONS.PHRASEBOOK_CREATE,
        RESOURCE_TYPES.PHRASEBOOK,
        result.id,
        { name, itemCount: data.length },
        req
      );

      log.info('Phrasebook created', {
        userId,
        phrasebookId: result.id,
        name,
        itemCount: data.length
      });

      return result.id;
    } catch (error) {
      log.error('Failed to create phrasebook', { error: error.message, userId });
      throw error;
    }
  }

  // Get user's phrasebook (create default if none exists)
  static async getUserPhrasebook(userId, req = null) {
    try {
      let phrasebook = await db.get(`
        SELECT id, name, data, created_at, updated_at
        FROM phrasebooks
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);

      if (!phrasebook) {
        // Create default phrasebook
        const phrasebookId = await this.createPhrasebook(userId, 'My Phrasebook', [], req);
        phrasebook = await db.get(`
          SELECT id, name, data, created_at, updated_at
          FROM phrasebooks
          WHERE id = ?
        `, [phrasebookId]);
      }

      // Log access
      if (req) {
        await AuditService.logEvent(
          userId,
          AUDIT_ACTIONS.PHRASEBOOK_READ,
          RESOURCE_TYPES.PHRASEBOOK,
          phrasebook.id,
          {},
          req
        );
      }

      return {
        id: phrasebook.id,
        name: phrasebook.name,
        data: JSON.parse(phrasebook.data || '[]'),
        createdAt: phrasebook.created_at,
        updatedAt: phrasebook.updated_at
      };
    } catch (error) {
      log.error('Failed to get user phrasebook', { error: error.message, userId });
      throw error;
    }
  }

  // Update phrasebook data
  static async updatePhrasebook(userId, phrasebookId, data, req = null) {
    try {
      // Verify ownership
      const existing = await db.get(`
        SELECT id FROM phrasebooks WHERE id = ? AND user_id = ?
      `, [phrasebookId, userId]);

      if (!existing) {
        throw new Error('Phrasebook not found or access denied');
      }

      const result = await db.run(`
        UPDATE phrasebooks 
        SET data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `, [JSON.stringify(data), phrasebookId, userId]);

      await AuditService.logEvent(
        userId,
        AUDIT_ACTIONS.PHRASEBOOK_UPDATE,
        RESOURCE_TYPES.PHRASEBOOK,
        phrasebookId,
        { itemCount: data.length },
        req
      );

      log.info('Phrasebook updated', {
        userId,
        phrasebookId,
        itemCount: data.length
      });

      return result.changes > 0;
    } catch (error) {
      log.error('Failed to update phrasebook', { 
        error: error.message, 
        userId, 
        phrasebookId 
      });
      throw error;
    }
  }

  // Delete phrasebook
  static async deletePhrasebook(userId, phrasebookId, req = null) {
    try {
      const result = await db.run(`
        DELETE FROM phrasebooks 
        WHERE id = ? AND user_id = ?
      `, [phrasebookId, userId]);

      if (result.changes > 0) {
        await AuditService.logEvent(
          userId,
          AUDIT_ACTIONS.PHRASEBOOK_DELETE,
          RESOURCE_TYPES.PHRASEBOOK,
          phrasebookId,
          {},
          req
        );

        log.info('Phrasebook deleted', { userId, phrasebookId });
      }

      return result.changes > 0;
    } catch (error) {
      log.error('Failed to delete phrasebook', { 
        error: error.message, 
        userId, 
        phrasebookId 
      });
      throw error;
    }
  }

  // Migrate existing JSON phrasebooks to database
  static async migrateJsonPhrasebooks() {
    const path = require('path');
    const USERDB_DIR = path.join(__dirname, 'userdb');
    
    try {
      // Ensure database is initialized
      if (!db || !db.get) {
        log.warn('Database not ready for phrasebook migration, skipping');
        return;
      }
      
      const files = await fs.readdir(USERDB_DIR);
      const phrasebookFiles = files.filter(f => f.startsWith('phrasebook_u_') && f.endsWith('.json'));

      log.info('Starting phrasebook migration', { 
        foundFiles: phrasebookFiles.length 
      });

      let migrated = 0;
      let errors = 0;

      for (const filename of phrasebookFiles) {
        try {
          // Extract user ID from filename: phrasebook_u_<userid>.json
          const userIdMatch = filename.match(/phrasebook_u_(.+)\.json$/);
          if (!userIdMatch) {
            log.warn('Invalid phrasebook filename format', { filename });
            continue;
          }

          const userId = userIdMatch[1];
          
          // Check if user exists in database (with error handling)
          let user = null;
          try {
            user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
          } catch (dbError) {
            log.warn('Database query failed during migration', { filename, error: dbError.message });
            continue;
          }
          if (!user) {
            // Create anonymous user entry for migration
            await db.run(`
              INSERT OR IGNORE INTO users (id, email, name, provider, tier)
              VALUES (?, ?, ?, ?, ?)
            `, [userId, `migrated_${userId}@local`, `Migrated User ${userId}`, 'migrated', 'free']);
          }

          // Read JSON file
          const filePath = path.join(USERDB_DIR, filename);
          const jsonData = await fs.readFile(filePath, 'utf8');
          const phrasebookData = JSON.parse(jsonData);

          // Check if already migrated
          const existing = await db.get(`
            SELECT id FROM phrasebooks WHERE user_id = ?
          `, [userId]);

          if (existing) {
            log.debug('Phrasebook already migrated', { userId, filename });
            continue;
          }

          // Create phrasebook in database
          await this.createPhrasebook(userId, 'Migrated Phrasebook', phrasebookData);

          // Backup original file
          const backupPath = path.join(USERDB_DIR, `${filename}.migrated`);
          await fs.rename(filePath, backupPath);

          migrated++;
          log.info('Phrasebook migrated successfully', { 
            userId, 
            filename,
            itemCount: phrasebookData.length 
          });

        } catch (fileError) {
          errors++;
          log.error('Failed to migrate phrasebook file', { 
            filename, 
            error: fileError.message 
          });
        }
      }

      log.info('Phrasebook migration completed', { 
        migrated, 
        errors,
        total: phrasebookFiles.length 
      });

      return { migrated, errors, total: phrasebookFiles.length };

    } catch (error) {
      log.error('Phrasebook migration failed', { error: error.message });
      throw error;
    }
  }

  // Legacy support: Get phrasebook by legacy user ID format
  static async getLegacyPhrasebook(legacyUserId) {
    try {
      // Try to find by legacy user ID format
      const phrasebook = await db.get(`
        SELECT id, name, data, created_at, updated_at
        FROM phrasebooks p
        JOIN users u ON p.user_id = u.id
        WHERE u.id = ? OR u.email = ?
        ORDER BY p.created_at DESC
        LIMIT 1
      `, [legacyUserId, `migrated_${legacyUserId}@local`]);

      if (!phrasebook) {
        return { data: [] }; // Return empty phrasebook
      }

      return {
        id: phrasebook.id,
        name: phrasebook.name,
        data: JSON.parse(phrasebook.data || '[]'),
        createdAt: phrasebook.created_at,
        updatedAt: phrasebook.updated_at
      };
    } catch (error) {
      log.error('Failed to get legacy phrasebook', { 
        error: error.message, 
        legacyUserId 
      });
      return { data: [] };
    }
  }
}

module.exports = {
  PhrasebookService
};


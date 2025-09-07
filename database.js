// database.js - Database setup and management
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'app.db');

// Initialize database connection
function initDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('❌ Database connection failed:', err.message);
        reject(err);
      } else {
        console.log('✅ Database connected successfully');
        resolve(db);
      }
    });
  });
}

// Create all required tables
async function createTables() {
  const db = await initDatabase();
  
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Users table
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT,
          name TEXT NOT NULL,
          provider TEXT DEFAULT 'email',
          provider_id TEXT,
          tier TEXT DEFAULT 'free',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_active BOOLEAN DEFAULT 1
        )
      `);

      // Organizations table
      db.run(`
        CREATE TABLE IF NOT EXISTS orgs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          tier TEXT DEFAULT 'team',
          created_by INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_active BOOLEAN DEFAULT 1,
          FOREIGN KEY (created_by) REFERENCES users (id)
        )
      `);

      // User-Organization relationships
      db.run(`
        CREATE TABLE IF NOT EXISTS user_orgs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          org_id INTEGER NOT NULL,
          role TEXT DEFAULT 'member',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (org_id) REFERENCES orgs (id),
          UNIQUE(user_id, org_id)
        )
      `);

      // API Keys table
      db.run(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          org_id INTEGER,
          key_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          tier TEXT NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (org_id) REFERENCES orgs (id)
        )
      `);

      // Sessions table
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          user_id INTEGER,
          sess TEXT NOT NULL,
          expire DATETIME NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // Usage counters table
      db.run(`
        CREATE TABLE IF NOT EXISTS usage_counters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          org_id INTEGER,
          api_key_id INTEGER,
          endpoint TEXT NOT NULL,
          count INTEGER DEFAULT 1,
          date DATE DEFAULT (date('now')),
          tokens_used INTEGER DEFAULT 0,
          characters_processed INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (org_id) REFERENCES orgs (id),
          FOREIGN KEY (api_key_id) REFERENCES api_keys (id)
        )
      `);

      // Phrasebook table (migrate from JSON files)
      db.run(`
        CREATE TABLE IF NOT EXISTS phrasebooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT 'My Phrasebook',
          data TEXT NOT NULL DEFAULT '[]',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // Files table (track S3 uploads)
      db.run(`
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          s3_key TEXT NOT NULL,
          original_name TEXT NOT NULL,
          mime_type TEXT,
          size_bytes INTEGER,
          file_type TEXT, -- 'upload', 'output', 'temp'
          status TEXT DEFAULT 'active', -- 'active', 'expired', 'deleted'
          expires_at DATETIME,
          metadata TEXT, -- JSON metadata
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // Audit logs table
      db.run(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          resource_type TEXT, -- 'file', 'phrasebook', 'user', 'api_key'
          resource_id TEXT,
          details TEXT, -- JSON details
          ip_address TEXT,
          user_agent TEXT,
          request_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // User feature/flag storage (e.g., free batch trial)
      db.run(`
        CREATE TABLE IF NOT EXISTS user_flags (
          user_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, key),
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // Active devices for concurrency enforcement
      db.run(`
        CREATE TABLE IF NOT EXISTS active_devices (
          user_id INTEGER NOT NULL,
          device_id TEXT NOT NULL,
          last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, device_id),
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // Document localization jobs
      db.run(`
        CREATE TABLE IF NOT EXISTS doc_jobs (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          status TEXT NOT NULL,
          file_key_in TEXT,
          file_key_out TEXT,
          src_lang TEXT,
          tgt_lang TEXT,
          mode TEXT,
          substyle TEXT,
          cache_key TEXT,
          meta TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS doc_segments (
          job_id TEXT NOT NULL,
          segment_id TEXT NOT NULL,
          src TEXT,
          tgt TEXT,
          meta TEXT,
          PRIMARY KEY (job_id, segment_id)
        )
      `);

      // Idempotency keys table
      db.run(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          response_data TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(key, user_id)
        )
      `, (err) => {
        if (err) {
          console.error('❌ Table creation failed:', err.message);
          reject(err);
        } else {
          console.log('✅ All database tables created successfully');
          resolve(db);
        }
      });
    });
  });
}

// Database helper functions
const db = {
  // Initialize database
  async init() {
    try {
      const database = await createTables();
      this.instance = database;
      return database;
    } catch (error) {
      console.error('Database initialization failed:', error);
      throw error;
    }
  },

  // Get database instance
  get() {
    if (!this.instance) {
      throw new Error('Database not initialized. Call db.init() first.');
    }
    return this.instance;
  },

  // Close database connection
  close() {
    if (this.instance) {
      this.instance.close();
      this.instance = null;
    }
  },

  // Run a query with parameters
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.instance.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  },

  // Get a single row
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.instance.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  // Get all rows
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.instance.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
};

module.exports = db;

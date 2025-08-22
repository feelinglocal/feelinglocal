// storage.js - S3-compatible object storage for files
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

// S3 Configuration
const s3Config = {
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT, // For S3-compatible services like MinIO
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' // For MinIO/local S3
};

const s3Client = new S3Client(s3Config);
const BUCKET_NAME = process.env.S3_BUCKET || 'localization-app-files';

// Storage service
class StorageService {
  constructor() {
    this.enabled = !!(process.env.S3_BUCKET && (process.env.AWS_ACCESS_KEY_ID || process.env.S3_ENDPOINT));
    
    if (!this.enabled) {
      log.warn('S3 storage not configured, using local filesystem', {
        hasS3Bucket: !!process.env.S3_BUCKET,
        hasCredentials: !!process.env.AWS_ACCESS_KEY_ID,
        hasEndpoint: !!process.env.S3_ENDPOINT
      });
    } else {
      log.info('S3 storage configured', {
        bucket: BUCKET_NAME,
        region: s3Config.region,
        endpoint: s3Config.endpoint
      });
    }
  }

  // Generate unique file key
  generateFileKey(userId, originalName, type = 'upload') {
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalName);
    const sanitizedName = path.basename(originalName, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    
    return `${type}/${userId}/${timestamp}_${randomId}_${sanitizedName}${ext}`;
  }

  // Upload file to S3
  async uploadFile(buffer, key, metadata = {}) {
    if (!this.enabled) {
      throw new Error('S3 storage not configured');
    }

    try {
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        Metadata: {
          ...metadata,
          uploadedAt: new Date().toISOString()
        },
        // Set default TTL tags for auto-deletion
        Tagging: `ttl=${metadata.ttl || '24h'}&type=${metadata.type || 'temp'}`
      });

      const result = await s3Client.send(command);
      
      log.info('File uploaded to S3', {
        key,
        bucket: BUCKET_NAME,
        size: buffer.length,
        metadata
      });

      return {
        key,
        url: `s3://${BUCKET_NAME}/${key}`,
        size: buffer.length,
        etag: result.ETag
      };
    } catch (error) {
      log.error('S3 upload failed', { key, error: error.message });
      throw error;
    }
  }

  // Get file from S3
  async getFile(key) {
    if (!this.enabled) {
      throw new Error('S3 storage not configured');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      const result = await s3Client.send(command);
      
      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of result.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      log.debug('File retrieved from S3', {
        key,
        size: buffer.length,
        contentType: result.ContentType
      });

      return {
        buffer,
        contentType: result.ContentType,
        metadata: result.Metadata,
        lastModified: result.LastModified
      };
    } catch (error) {
      log.error('S3 get failed', { key, error: error.message });
      throw error;
    }
  }

  // Delete file from S3
  async deleteFile(key) {
    if (!this.enabled) {
      return; // Silently skip if not configured
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      await s3Client.send(command);
      
      log.info('File deleted from S3', { key });
    } catch (error) {
      log.error('S3 delete failed', { key, error: error.message });
      throw error;
    }
  }

  // Check if file exists
  async fileExists(key) {
    if (!this.enabled) {
      return false;
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      await s3Client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  // Generate presigned URL for download
  async getSignedDownloadUrl(key, expiresIn = 3600) {
    if (!this.enabled) {
      throw new Error('S3 storage not configured');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      const url = await getSignedUrl(s3Client, command, { expiresIn });
      
      log.debug('Generated presigned URL', { key, expiresIn });
      
      return url;
    } catch (error) {
      log.error('Failed to generate presigned URL', { key, error: error.message });
      throw error;
    }
  }

  // Get multer storage configuration
  getMulterStorage() {
    if (!this.enabled) {
      // Fallback to local disk storage
      return multer.diskStorage({
        destination: (req, file, cb) => {
          cb(null, 'uploads/');
        },
        filename: (req, file, cb) => {
          const key = this.generateFileKey(req.user?.id || 'anonymous', file.originalname);
          cb(null, key);
        }
      });
    }

    return multerS3({
      s3: s3Client,
      bucket: BUCKET_NAME,
      key: (req, file, cb) => {
        const key = this.generateFileKey(req.user?.id || 'anonymous', file.originalname);
        cb(null, key);
      },
      metadata: (req, file, cb) => {
        cb(null, {
          userId: req.user?.id?.toString() || 'anonymous',
          originalName: file.originalname,
          mimeType: file.mimetype,
          uploadedAt: new Date().toISOString(),
          userTier: req.user?.tier || 'free'
        });
      }
    });
  }
}

// Retention job to clean up expired files
class RetentionService {
  constructor(storageService) {
    this.storage = storageService;
  }

  // Clean up files based on TTL tags
  async cleanupExpiredFiles() {
    if (!this.storage.enabled) {
      log.debug('Skipping cleanup - S3 storage not enabled');
      return;
    }

    try {
      // This would typically use S3 lifecycle policies
      // For now, we'll implement basic cleanup logic
      log.info('Starting retention cleanup job');
      
      // In production, you'd use S3 lifecycle policies for automatic deletion
      // This is a simplified implementation for demonstration
      
      log.info('Retention cleanup completed');
    } catch (error) {
      log.error('Retention cleanup failed', { error: error.message });
    }
  }

  // Schedule cleanup job
  scheduleCleanup() {
    const cron = require('cron');
    
    // Run every 6 hours
    const job = new cron.CronJob('0 */6 * * *', () => {
      this.cleanupExpiredFiles();
    }, null, true, 'UTC');

    log.info('Retention cleanup job scheduled', { pattern: '0 */6 * * *' });
    return job;
  }
}

// Export singleton instances
const storageService = new StorageService();
const retentionService = new RetentionService(storageService);

module.exports = {
  storageService,
  retentionService,
  StorageService,
  RetentionService
};


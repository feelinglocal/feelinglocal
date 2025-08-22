// websocket.js - Real-time WebSocket notifications for job progress
const { Server } = require('socket.io');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

/**
 * WebSocket Manager for real-time job progress updates
 */
class WebSocketManager {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // userId -> Set of socket IDs
    this.socketToUser = new Map();   // socket.id -> userId
    this.jobSubscriptions = new Map(); // jobId -> Set of socket IDs
    this.stats = {
      connectionsTotal: 0,
      disconnectionsTotal: 0,
      messagesTotal: 0,
      jobUpdatesTotal: 0
    };
  }

  /**
   * Initialize WebSocket server
   */
  init(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.WEBSOCKET_CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
      },
      pingTimeout: Number(process.env.WEBSOCKET_PING_TIMEOUT || 20000),
      pingInterval: Number(process.env.WEBSOCKET_PING_INTERVAL || 25000),
      transports: ['websocket', 'polling'],
      allowEIO3: true
    });

    this.setupEventHandlers();
    this.setupNamespaces();
    
    log.info('WebSocket server initialized', {
      pingTimeout: this.io.engine.pingTimeout,
      pingInterval: this.io.engine.pingInterval
    });
  }

  /**
   * Set up main event handlers
   */
  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    this.io.engine.on('connection_error', (err) => {
      log.error('WebSocket connection error', { 
        error: err.message,
        code: err.code,
        context: err.context
      });
      recordMetrics.circuitBreakerFailure('websocket:connection');
    });
  }

  /**
   * Set up specialized namespaces
   */
  setupNamespaces() {
    // Jobs namespace for job progress updates
    const jobsNamespace = this.io.of('/jobs');
    jobsNamespace.on('connection', (socket) => {
      this.handleJobsConnection(socket);
    });

    // Admin namespace for administrative features
    const adminNamespace = this.io.of('/admin');
    adminNamespace.use(this.adminAuthMiddleware.bind(this));
    adminNamespace.on('connection', (socket) => {
      this.handleAdminConnection(socket);
    });
  }

  /**
   * Handle main connection
   */
  handleConnection(socket) {
    this.stats.connectionsTotal++;
    
    log.info('WebSocket client connected', { 
      socketId: socket.id,
      userAgent: socket.handshake.headers['user-agent'],
      ip: socket.handshake.address
    });

    // Authentication check
    const userId = this.extractUserId(socket);
    if (userId) {
      this.registerUserSocket(userId, socket.id);
    }

    // Set up event listeners
    socket.on('authenticate', (data) => this.handleAuthentication(socket, data));
    socket.on('subscribe_job', (jobId) => this.handleJobSubscription(socket, jobId));
    socket.on('unsubscribe_job', (jobId) => this.handleJobUnsubscription(socket, jobId));
    socket.on('heartbeat', () => this.handleHeartbeat(socket));
    socket.on('get_status', () => this.handleStatusRequest(socket));

    socket.on('disconnect', (reason) => {
      this.handleDisconnection(socket, reason);
    });

    socket.on('error', (error) => {
      log.error('WebSocket socket error', { 
        socketId: socket.id, 
        error: error.message 
      });
    });

    // Send initial connection acknowledgment
    socket.emit('connected', {
      socketId: socket.id,
      timestamp: Date.now(),
      serverTime: new Date().toISOString()
    });
  }

  /**
   * Handle jobs namespace connection
   */
  handleJobsConnection(socket) {
    log.debug('Jobs namespace connection', { socketId: socket.id });
    
    socket.on('subscribe_all_jobs', () => {
      socket.join('all_jobs');
      log.debug('Socket subscribed to all jobs', { socketId: socket.id });
    });

    socket.on('unsubscribe_all_jobs', () => {
      socket.leave('all_jobs');
      log.debug('Socket unsubscribed from all jobs', { socketId: socket.id });
    });
  }

  /**
   * Handle admin namespace connection with authentication
   */
  handleAdminConnection(socket) {
    log.info('Admin WebSocket connection', { 
      socketId: socket.id,
      userId: socket.userId 
    });

    socket.join('admin_room');
    
    // Send system stats
    socket.emit('system_stats', this.getSystemStats());
    
    // Set up admin-specific events
    socket.on('get_queue_stats', () => {
      this.sendQueueStats(socket);
    });

    socket.on('get_circuit_breaker_stats', () => {
      this.sendCircuitBreakerStats(socket);
    });
  }

  /**
   * Authentication middleware for admin namespace
   */
  async adminAuthMiddleware(socket, next) {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Verify JWT token (you would use your actual JWT verification here)
      const { requireAuth } = require('./auth');
      const mockReq = { headers: { authorization: `Bearer ${token}` } };
      const mockRes = {};
      
      await new Promise((resolve, reject) => {
        requireAuth(mockReq, mockRes, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Check if user has admin privileges
      if (!mockReq.user || mockReq.user.tier === 'free') {
        return next(new Error('Admin access required'));
      }

      socket.userId = mockReq.user.id;
      socket.userTier = mockReq.user.tier;
      next();
      
    } catch (error) {
      log.warn('Admin WebSocket authentication failed', { error: error.message });
      next(new Error('Authentication failed'));
    }
  }

  /**
   * Extract user ID from socket connection
   */
  extractUserId(socket) {
    // Try to get user ID from various sources
    const token = socket.handshake.auth.token || 
                 socket.handshake.headers.authorization?.replace('Bearer ', '') ||
                 socket.handshake.query.token;
    
    if (token) {
      try {
        // Decode JWT to get user ID (simplified - you'd use proper JWT verification)
        const base64Payload = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString());
        return payload.sub || payload.userId || payload.id;
      } catch (error) {
        log.debug('Failed to extract user ID from token', { error: error.message });
      }
    }

    // Fallback to session or other identification methods
    return socket.handshake.query.userId || null;
  }

  /**
   * Register user socket mapping
   */
  registerUserSocket(userId, socketId) {
    if (!this.connectedUsers.has(userId)) {
      this.connectedUsers.set(userId, new Set());
    }
    this.connectedUsers.get(userId).add(socketId);
    this.socketToUser.set(socketId, userId);

    log.debug('User socket registered', { userId, socketId });
  }

  /**
   * Handle authentication
   */
  handleAuthentication(socket, data) {
    const { token, userId } = data;
    
    if (userId) {
      this.registerUserSocket(userId, socket.id);
      socket.emit('authenticated', { success: true, userId });
      log.debug('Socket authenticated', { socketId: socket.id, userId });
    } else {
      socket.emit('authenticated', { success: false, error: 'Invalid credentials' });
    }
  }

  /**
   * Handle job subscription
   */
  handleJobSubscription(socket, jobId) {
    if (!jobId) return;

    if (!this.jobSubscriptions.has(jobId)) {
      this.jobSubscriptions.set(jobId, new Set());
    }
    this.jobSubscriptions.get(jobId).add(socket.id);
    
    socket.join(`job:${jobId}`);
    socket.emit('job_subscribed', { jobId, timestamp: Date.now() });
    
    log.debug('Socket subscribed to job', { socketId: socket.id, jobId });
  }

  /**
   * Handle job unsubscription
   */
  handleJobUnsubscription(socket, jobId) {
    if (!jobId) return;

    if (this.jobSubscriptions.has(jobId)) {
      this.jobSubscriptions.get(jobId).delete(socket.id);
      if (this.jobSubscriptions.get(jobId).size === 0) {
        this.jobSubscriptions.delete(jobId);
      }
    }
    
    socket.leave(`job:${jobId}`);
    socket.emit('job_unsubscribed', { jobId, timestamp: Date.now() });
    
    log.debug('Socket unsubscribed from job', { socketId: socket.id, jobId });
  }

  /**
   * Handle heartbeat
   */
  handleHeartbeat(socket) {
    socket.emit('heartbeat_ack', { 
      timestamp: Date.now(),
      serverTime: new Date().toISOString()
    });
  }

  /**
   * Handle status request
   */
  handleStatusRequest(socket) {
    const userId = this.socketToUser.get(socket.id);
    const userSockets = userId ? this.connectedUsers.get(userId)?.size || 0 : 0;
    
    socket.emit('status_response', {
      connected: true,
      userId,
      userSockets,
      serverTime: new Date().toISOString(),
      stats: this.getPublicStats()
    });
  }

  /**
   * Handle disconnection
   */
  handleDisconnection(socket, reason) {
    this.stats.disconnectionsTotal++;
    
    const userId = this.socketToUser.get(socket.id);
    
    // Clean up user mappings
    if (userId && this.connectedUsers.has(userId)) {
      this.connectedUsers.get(userId).delete(socket.id);
      if (this.connectedUsers.get(userId).size === 0) {
        this.connectedUsers.delete(userId);
      }
    }
    this.socketToUser.delete(socket.id);

    // Clean up job subscriptions
    for (const [jobId, sockets] of this.jobSubscriptions.entries()) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        this.jobSubscriptions.delete(jobId);
      }
    }

    log.info('WebSocket client disconnected', { 
      socketId: socket.id, 
      userId, 
      reason 
    });
  }

  /**
   * Send job progress update to subscribed clients
   */
  sendJobProgress(jobId, progress, metadata = {}) {
    const message = {
      jobId,
      progress,
      timestamp: Date.now(),
      ...metadata
    };

    // Send to specific job subscribers
    this.io.to(`job:${jobId}`).emit('job_progress', message);
    
    // Send to admin namespace
    this.io.of('/admin').emit('job_progress', message);
    
    // Send to jobs namespace subscribers
    this.io.of('/jobs').to('all_jobs').emit('job_progress', message);

    this.stats.jobUpdatesTotal++;
    recordMetrics.circuitBreakerSuccess('websocket:job_progress');
    
    log.debug('Job progress sent', { jobId, progress, subscriberCount: this.jobSubscriptions.get(jobId)?.size || 0 });
  }

  /**
   * Send job completion notification
   */
  sendJobComplete(jobId, result, metadata = {}) {
    const message = {
      jobId,
      status: 'completed',
      result,
      timestamp: Date.now(),
      ...metadata
    };

    this.io.to(`job:${jobId}`).emit('job_complete', message);
    this.io.of('/admin').emit('job_complete', message);
    this.io.of('/jobs').to('all_jobs').emit('job_complete', message);

    // Clean up subscriptions for completed job
    this.jobSubscriptions.delete(jobId);

    log.info('Job completion sent', { jobId, subscriberCount: this.jobSubscriptions.get(jobId)?.size || 0 });
  }

  /**
   * Send job failure notification
   */
  sendJobFailure(jobId, error, metadata = {}) {
    const message = {
      jobId,
      status: 'failed',
      error: error.message || error,
      timestamp: Date.now(),
      ...metadata
    };

    this.io.to(`job:${jobId}`).emit('job_failed', message);
    this.io.of('/admin').emit('job_failed', message);
    this.io.of('/jobs').to('all_jobs').emit('job_failed', message);

    // Clean up subscriptions for failed job
    this.jobSubscriptions.delete(jobId);

    log.warn('Job failure sent', { jobId, error: error.message || error });
  }

  /**
   * Send real-time translation result
   */
  sendTranslationResult(userId, result, metadata = {}) {
    const userSockets = this.connectedUsers.get(userId);
    if (userSockets) {
      for (const socketId of userSockets) {
        this.io.to(socketId).emit('translation_result', {
          result,
          timestamp: Date.now(),
          ...metadata
        });
      }
      this.stats.messagesTotal++;
    }
  }

  /**
   * Send system notification to user
   */
  sendNotification(userId, notification) {
    const userSockets = this.connectedUsers.get(userId);
    if (userSockets) {
      for (const socketId of userSockets) {
        this.io.to(socketId).emit('notification', {
          ...notification,
          timestamp: Date.now()
        });
      }
    }
  }

  /**
   * Broadcast system announcement
   */
  broadcastAnnouncement(announcement) {
    this.io.emit('system_announcement', {
      ...announcement,
      timestamp: Date.now()
    });
    
    log.info('System announcement broadcast', { announcement });
  }

  /**
   * Send queue statistics to admin clients
   */
  async sendQueueStats(socket) {
    try {
      const { getQueueMetrics } = require('./queue');
      const queueStats = await Promise.all([
        getQueueMetrics('translation-long'),
        getQueueMetrics('file-processing'),
        getQueueMetrics('batch-translation')
      ]);

      socket.emit('queue_stats', {
        queues: queueStats,
        timestamp: Date.now()
      });
    } catch (error) {
      socket.emit('error', { message: 'Failed to get queue stats' });
    }
  }

  /**
   * Send circuit breaker statistics to admin clients
   */
  sendCircuitBreakerStats(socket) {
    try {
      const { circuitBreakerService } = require('./circuit-breaker');
      const stats = circuitBreakerService.getStats();
      const health = circuitBreakerService.healthCheck();

      socket.emit('circuit_breaker_stats', {
        stats,
        health,
        timestamp: Date.now()
      });
    } catch (error) {
      socket.emit('error', { message: 'Failed to get circuit breaker stats' });
    }
  }

  /**
   * Get system statistics
   */
  getSystemStats() {
    return {
      connections: {
        total: this.io.engine.clientsCount,
        users: this.connectedUsers.size,
        sockets: this.socketToUser.size
      },
      subscriptions: {
        jobs: this.jobSubscriptions.size,
        totalSubscribers: Array.from(this.jobSubscriptions.values())
          .reduce((sum, set) => sum + set.size, 0)
      },
      stats: this.stats,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
  }

  /**
   * Get public statistics (safe for non-admin users)
   */
  getPublicStats() {
    return {
      connectionsCount: this.io.engine.clientsCount,
      serverUptime: process.uptime(),
      serverTime: new Date().toISOString()
    };
  }

  /**
   * Health check for WebSocket system
   */
  healthCheck() {
    const stats = this.getSystemStats();
    const isHealthy = stats.connections.total >= 0 && this.io?.engine?.readyState === 'open';
    
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      connections: stats.connections.total,
      users: stats.connections.users,
      jobSubscriptions: stats.subscriptions.jobs,
      lastMessageTime: Date.now()
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.io) {
      log.info('Shutting down WebSocket server...');
      
      // Notify all clients of shutdown
      this.io.emit('server_shutdown', {
        message: 'Server is shutting down',
        timestamp: Date.now()
      });

      // Wait a moment for messages to be sent
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Close all connections
      this.io.close();
      
      // Clear mappings
      this.connectedUsers.clear();
      this.socketToUser.clear();
      this.jobSubscriptions.clear();
      
      log.info('WebSocket server shutdown completed');
    }
  }
}

// Global WebSocket manager instance
const webSocketManager = new WebSocketManager();

/**
 * Initialize WebSocket with HTTP server
 */
function initWebSocket(httpServer) {
  webSocketManager.init(httpServer);
  return webSocketManager;
}

/**
 * Middleware to add WebSocket capabilities to request context
 */
function webSocketMiddleware(req, res, next) {
  req.websocket = {
    sendJobProgress: (jobId, progress, metadata) => 
      webSocketManager.sendJobProgress(jobId, progress, metadata),
    sendJobComplete: (jobId, result, metadata) => 
      webSocketManager.sendJobComplete(jobId, result, metadata),
    sendJobFailure: (jobId, error, metadata) => 
      webSocketManager.sendJobFailure(jobId, error, metadata),
    sendNotification: (userId, notification) => 
      webSocketManager.sendNotification(userId, notification),
    sendTranslationResult: (userId, result, metadata) => 
      webSocketManager.sendTranslationResult(userId, result, metadata),
    getStats: () => webSocketManager.getSystemStats(),
    healthCheck: () => webSocketManager.healthCheck()
  };
  next();
}

module.exports = {
  WebSocketManager,
  webSocketManager,
  initWebSocket,
  webSocketMiddleware
};

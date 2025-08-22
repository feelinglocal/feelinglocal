// queue.js - Job Queue System for Long-running Translation Jobs
const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

// Redis connection configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_CONFIG = process.env.REDIS_URL ? {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  lazyConnect: true
} : {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  lazyConnect: true
};

// Create Redis connection
const connection = new IORedis(REDIS_CONFIG);

// Queue configurations
const QUEUE_CONFIGS = {
  'translation-long': {
    defaultJobOptions: {
      removeOnComplete: 10,
      removeOnFail: 5,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      }
    }
  },
  'file-processing': {
    defaultJobOptions: {
      removeOnComplete: 5,
      removeOnFail: 3,
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000,
      }
    }
  },
  'batch-translation': {
    defaultJobOptions: {
      removeOnComplete: 15,
      removeOnFail: 5,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1500,
      }
    }
  }
};

// Initialize queues
const queues = {};
const workers = {};
const queueEvents = {};

/**
 * Initialize queue system
 */
async function initQueueSystem() {
  try {
    // Test Redis connection
    await connection.ping();
    log.info('Redis connection established for queue system');

    // Initialize queues
    for (const [queueName, config] of Object.entries(QUEUE_CONFIGS)) {
      queues[queueName] = new Queue(queueName, {
        connection,
        ...config
      });

      // Set global concurrency limits
      await queues[queueName].setGlobalConcurrency(
        Number(process.env[`${queueName.toUpperCase().replace('-', '_')}_CONCURRENCY`] || 5)
      );

      // Initialize queue events
      queueEvents[queueName] = new QueueEvents(queueName, { connection });
      
      // Set up event listeners
      setupQueueEventListeners(queueName, queueEvents[queueName]);
    }

    log.info('Queue system initialized successfully');
  } catch (error) {
    log.error('Failed to initialize queue system', { error: error.message });
    throw error;
  }
}

/**
 * Set up event listeners for queue events
 */
function setupQueueEventListeners(queueName, queueEvents) {
  queueEvents.on('completed', ({ jobId, returnvalue }) => {
    log.info(`Job completed in ${queueName}`, { jobId, returnvalue });
    recordMetrics.jobCompleted(queueName, 'completed');
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    log.error(`Job failed in ${queueName}`, { jobId, failedReason });
    recordMetrics.jobCompleted(queueName, 'failed');
  });

  queueEvents.on('progress', ({ jobId, data }) => {
    log.debug(`Job progress in ${queueName}`, { jobId, progress: data });
  });

  queueEvents.on('active', ({ jobId }) => {
    log.debug(`Job started in ${queueName}`, { jobId });
    recordMetrics.jobStarted(queueName);
  });

  queueEvents.on('stalled', ({ jobId }) => {
    log.warn(`Job stalled in ${queueName}`, { jobId });
    recordMetrics.jobStalled(queueName);
  });
}

/**
 * Create workers with configurable concurrency
 */
function createWorker(queueName, processor, options = {}) {
  const concurrency = Number(process.env[`${queueName.toUpperCase().replace('-', '_')}_WORKER_CONCURRENCY`] || 3);
  
  const worker = new Worker(queueName, processor, {
    connection,
    concurrency,
    removeOnComplete: 10,
    removeOnFail: 5,
    ...options
  });

  // Worker event listeners
  worker.on('completed', (job) => {
    log.info(`Worker completed job ${job.id} in ${queueName}`, { 
      jobId: job.id, 
      duration: Date.now() - job.processedOn 
    });
  });

  worker.on('failed', (job, err) => {
    log.error(`Worker failed job ${job.id} in ${queueName}`, { 
      jobId: job.id, 
      error: err.message 
    });
  });

  worker.on('stalled', (jobId) => {
    log.warn(`Worker stalled on job ${jobId} in ${queueName}`, { jobId });
  });

  worker.on('error', (err) => {
    log.error(`Worker error in ${queueName}`, { error: err.message });
  });

  workers[queueName] = worker;
  return worker;
}

/**
 * Add job to queue with priority and delay support
 */
async function addJob(queueName, jobName, data, options = {}) {
  try {
    if (!queues[queueName]) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const job = await queues[queueName].add(jobName, data, {
      priority: options.priority || 0,
      delay: options.delay || 0,
      removeOnComplete: options.removeOnComplete || 10,
      removeOnFail: options.removeOnFail || 5,
      jobId: options.jobId, // For idempotency
      ...options
    });

    log.info(`Job added to ${queueName}`, { 
      jobId: job.id, 
      jobName, 
      priority: options.priority || 0 
    });

    return job;
  } catch (error) {
    log.error(`Failed to add job to ${queueName}`, { error: error.message, jobName });
    throw error;
  }
}

/**
 * Get job status and progress
 */
async function getJobStatus(queueName, jobId) {
  try {
    if (!queues[queueName]) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const job = await queues[queueName].getJob(jobId);
    if (!job) {
      return null;
    }

    const state = await job.getState();
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      state,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade
    };
  } catch (error) {
    log.error(`Failed to get job status`, { queueName, jobId, error: error.message });
    throw error;
  }
}

/**
 * Get queue metrics and health
 */
async function getQueueMetrics(queueName) {
  try {
    if (!queues[queueName]) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const queue = queues[queueName];
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
      queue.getDelayed()
    ]);

    const globalConcurrency = await queue.getGlobalConcurrency();

    return {
      queueName,
      counts: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length
      },
      globalConcurrency,
      worker: workers[queueName] ? {
        concurrency: workers[queueName].concurrency,
        running: workers[queueName].running
      } : null
    };
  } catch (error) {
    log.error(`Failed to get queue metrics`, { queueName, error: error.message });
    throw error;
  }
}

/**
 * Gracefully shutdown queue system
 */
async function shutdownQueueSystem() {
  try {
    log.info('Shutting down queue system...');

    // Close all workers gracefully
    const workerPromises = Object.values(workers).map(worker => worker.close());
    await Promise.all(workerPromises);

    // Close all queue events
    const eventPromises = Object.values(queueEvents).map(events => events.close());
    await Promise.all(eventPromises);

    // Close all queues
    const queuePromises = Object.values(queues).map(queue => queue.close());
    await Promise.all(queuePromises);

    // Close Redis connection
    await connection.quit();

    log.info('Queue system shutdown completed');
  } catch (error) {
    log.error('Error during queue system shutdown', { error: error.message });
    throw error;
  }
}

/**
 * Health check for queue system
 */
async function healthCheck() {
  try {
    // Check Redis connection
    await connection.ping();
    
    // Check each queue
    const queueHealth = {};
    for (const queueName of Object.keys(queues)) {
      try {
        const metrics = await getQueueMetrics(queueName);
        queueHealth[queueName] = {
          status: 'healthy',
          ...metrics.counts
        };
      } catch (error) {
        queueHealth[queueName] = {
          status: 'unhealthy',
          error: error.message
        };
      }
    }

    return {
      redis: 'connected',
      queues: queueHealth
    };
  } catch (error) {
    return {
      redis: 'disconnected',
      error: error.message,
      queues: {}
    };
  }
}

module.exports = {
  initQueueSystem,
  createWorker,
  addJob,
  getJobStatus,
  getQueueMetrics,
  shutdownQueueSystem,
  healthCheck,
  queues,
  workers,
  connection
};

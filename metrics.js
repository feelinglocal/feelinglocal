// metrics.js - Prometheus metrics collection
const client = require('prom-client');

// Create a Registry which registers the metrics
const register = new client.Registry();

// Add a default label which is added to all metrics
register.setDefaultLabels({
  app: 'localization-app'
});

// Enable the collection of default metrics
client.collectDefaultMetrics({
  register,
  prefix: 'localization_'
});

// Custom metrics
const metrics = {
  // HTTP request duration histogram
  httpRequestDuration: new client.Histogram({
    name: 'localization_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code', 'user_tier'],
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
  }),

  // HTTP request counter
  httpRequestsTotal: new client.Counter({
    name: 'localization_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code', 'user_tier']
  }),

  // Translation counter
  translationsTotal: new client.Counter({
    name: 'localization_translations_total',
    help: 'Total number of translations performed',
    labelNames: ['type', 'mode', 'target_language', 'user_tier', 'success']
  }),

  // Characters processed counter
  charactersProcessed: new client.Counter({
    name: 'localization_characters_processed_total',
    help: 'Total number of characters processed',
    labelNames: ['type', 'user_tier']
  }),

  // OpenAI API calls
  openaiCallsTotal: new client.Counter({
    name: 'localization_openai_calls_total',
    help: 'Total number of OpenAI API calls',
    labelNames: ['endpoint', 'success']
  }),

  // OpenAI API duration
  openaiCallDuration: new client.Histogram({
    name: 'localization_openai_call_duration_seconds',
    help: 'Duration of OpenAI API calls in seconds',
    labelNames: ['endpoint'],
    buckets: [0.5, 1, 2, 5, 10, 15, 30]
  }),

  // OpenAI tokens used
  openaiTokensUsed: new client.Counter({
    name: 'localization_openai_tokens_used_total',
    help: 'Total number of OpenAI tokens consumed',
    labelNames: ['type', 'user_tier'] // type: prompt, completion
  }),

  // Gemini API calls
  geminiCallsTotal: new client.Counter({
    name: 'localization_gemini_calls_total',
    help: 'Total number of Gemini API calls',
    labelNames: ['endpoint', 'success']
  }),

  // Gemini API duration
  geminiCallDuration: new client.Histogram({
    name: 'localization_gemini_call_duration_seconds',
    help: 'Duration of Gemini API calls in seconds',
    labelNames: ['endpoint'],
    buckets: [0.5, 1, 2, 5, 10, 15, 30]
  }),

  // Gemini tokens used (if available)
  geminiTokensUsed: new client.Counter({
    name: 'localization_gemini_tokens_used_total',
    help: 'Total number of Gemini tokens consumed',
    labelNames: ['type', 'user_tier'] // type: prompt, completion
  }),

  // Router decisions
  routerDecisionsTotal: new client.Counter({
    name: 'localization_router_decisions_total',
    help: 'Number of routing decisions',
    labelNames: ['decision', 'reason', 'mode', 'sub_style', 'target_language']
  }),

  // Escalations (engine to engine)
  escalationsTotal: new client.Counter({
    name: 'localization_router_escalations_total',
    help: 'Escalations from one engine to another',
    labelNames: ['from', 'to', 'reason']
  }),

  // Collaboration steps (review/repair/committee)
  collabSteps: new client.Counter({
    name: 'localization_collab_steps_total',
    help: 'Steps executed in collaboration workflows',
    labelNames: ['step','primary','secondary','arbiter','outcome']
  }),

  // Lightweight QE score histogram
  qeScore: new client.Histogram({
    name: 'localization_qe_score',
    help: 'Quality estimation score (0..1)',
    labelNames: [],
    buckets: [0.2, 0.4, 0.6, 0.72, 0.8, 0.9, 1.0]
  }),

  // Active users gauge
  activeUsers: new client.Gauge({
    name: 'localization_active_users',
    help: 'Number of active users',
    labelNames: ['tier']
  }),

  // Rate limit hits
  rateLimitHits: new client.Counter({
    name: 'localization_rate_limit_hits_total',
    help: 'Total number of rate limit hits',
    labelNames: ['type', 'user_tier'] // type: request, quota
  }),

  // Database operation duration
  dbOperationDuration: new client.Histogram({
    name: 'localization_db_operation_duration_seconds',
    help: 'Duration of database operations in seconds',
    labelNames: ['operation', 'table'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
  }),

  // File upload size
  fileUploadSize: new client.Histogram({
    name: 'localization_file_upload_size_bytes',
    help: 'Size of uploaded files in bytes',
    labelNames: ['file_type', 'user_tier'],
    buckets: [1024, 10240, 102400, 1048576, 10485760, 26214400] // 1KB to 25MB
  }),

  // Queue depth
  queueDepth: new client.Gauge({
    name: 'localization_queue_depth',
    help: 'Number of items in processing queue',
    labelNames: ['queue_name', 'state'] // state: waiting, active, completed, failed, delayed
  }),

  // Job processing metrics
  jobsProcessed: new client.Counter({
    name: 'localization_jobs_processed_total',
    help: 'Total number of jobs processed',
    labelNames: ['queue_name', 'status'] // status: completed, failed, stalled
  }),

  // Job duration
  jobDuration: new client.Histogram({
    name: 'localization_job_duration_seconds',
    help: 'Duration of job processing in seconds',
    labelNames: ['queue_name', 'job_name'],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300] // Up to 5 minutes
  }),

  // Circuit breaker metrics
  circuitBreakerCalls: new client.Counter({
    name: 'localization_circuit_breaker_calls_total',
    help: 'Total number of circuit breaker calls',
    labelNames: ['breaker_name', 'result'] // result: success, failure, timeout, reject, fallback
  }),

  // Circuit breaker state
  circuitBreakerState: new client.Gauge({
    name: 'localization_circuit_breaker_state',
    help: 'Current state of circuit breaker (0=closed, 1=open, 2=halfOpen)',
    labelNames: ['breaker_name']
  }),

  // Circuit breaker latency
  circuitBreakerLatency: new client.Histogram({
    name: 'localization_circuit_breaker_latency_seconds',
    help: 'Latency of circuit breaker calls',
    labelNames: ['breaker_name'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30]
  })
};

// Register all custom metrics
Object.values(metrics).forEach(metric => {
  register.registerMetric(metric);
});

// Helper functions to record metrics
const recordMetrics = {
  // Record HTTP request
  httpRequest: (method, route, statusCode, duration, userTier = 'anonymous') => {
    const labels = { method, route, status_code: statusCode.toString(), user_tier: userTier };
    metrics.httpRequestDuration.observe(labels, duration / 1000); // Convert to seconds
    metrics.httpRequestsTotal.inc(labels);
  },

  // Record translation
  translation: (type, mode, targetLanguage, userTier, success, charactersCount) => {
    const labels = { type, mode, target_language: targetLanguage, user_tier: userTier, success: success.toString() };
    metrics.translationsTotal.inc(labels);
    
    if (charactersCount > 0) {
      metrics.charactersProcessed.inc({ type, user_tier: userTier }, charactersCount);
    }
  },

  // Record OpenAI API call
  openaiCall: (endpoint, duration, success, tokensUsed = 0, userTier = 'unknown') => {
    metrics.openaiCallsTotal.inc({ endpoint, success: success.toString() });
    metrics.openaiCallDuration.observe({ endpoint }, duration / 1000);
    
    if (tokensUsed > 0) {
      // Estimate prompt vs completion tokens (rough split)
      const promptTokens = Math.floor(tokensUsed * 0.4);
      const completionTokens = tokensUsed - promptTokens;
      
      metrics.openaiTokensUsed.inc({ type: 'prompt', user_tier: userTier }, promptTokens);
      metrics.openaiTokensUsed.inc({ type: 'completion', user_tier: userTier }, completionTokens);
    }
  },

  // Record Gemini API call
  geminiCall: (endpoint, duration, success, tokensUsed = 0, userTier = 'unknown') => {
    metrics.geminiCallsTotal.inc({ endpoint, success: success.toString() });
    metrics.geminiCallDuration.observe({ endpoint }, duration / 1000);

    if (tokensUsed > 0) {
      const promptTokens = Math.floor(tokensUsed * 0.4);
      const completionTokens = tokensUsed - promptTokens;

      metrics.geminiTokensUsed.inc({ type: 'prompt', user_tier: userTier }, promptTokens);
      metrics.geminiTokensUsed.inc({ type: 'completion', user_tier: userTier }, completionTokens);
    }
  },

  // Record rate limit hit
  rateLimitHit: (type, userTier = 'anonymous') => {
    metrics.rateLimitHits.inc({ type, user_tier: userTier });
  },

  // Router decision helper
  routerDecision: (decision, reason, mode = '', subStyle = '', targetLanguage = '') => {
    metrics.routerDecisionsTotal.inc({ decision, reason, mode, sub_style: subStyle || 'general', target_language: targetLanguage || '' });
  },

  // Record database operation
  dbOperation: (operation, table, duration) => {
    metrics.dbOperationDuration.observe({ operation, table }, duration / 1000);
  },

  // Record file upload
  fileUpload: (fileType, size, userTier) => {
    metrics.fileUploadSize.observe({ file_type: fileType, user_tier: userTier }, size);
  },

  // Update active users count
  updateActiveUsers: (tier, count) => {
    metrics.activeUsers.set({ tier }, count);
  },

  // Record job metrics
  jobCompleted: (queueName, status) => {
    metrics.jobsProcessed.inc({ queue_name: queueName, status });
  },

  jobStarted: (queueName) => {
    // This will be used with job duration tracking
  },

  jobStalled: (queueName) => {
    metrics.jobsProcessed.inc({ queue_name: queueName, status: 'stalled' });
  },

  jobDuration: (queueName, jobName, duration) => {
    metrics.jobDuration.observe({ queue_name: queueName, job_name: jobName }, duration / 1000);
  },

  // Update queue depth
  updateQueueDepth: (queueName, state, count) => {
    metrics.queueDepth.set({ queue_name: queueName, state }, count);
  },

  // Circuit breaker metrics
  circuitBreakerFire: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'fire' });
  },

  circuitBreakerSuccess: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'success' });
  },

  circuitBreakerFailure: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'failure' });
  },

  circuitBreakerTimeout: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'timeout' });
  },

  circuitBreakerReject: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'reject' });
  },

  circuitBreakerFallback: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'fallback' });
  },

  circuitBreakerSemaphoreLocked: (breakerName) => {
    metrics.circuitBreakerCalls.inc({ breaker_name: breakerName, result: 'semaphore_locked' });
  },

  circuitBreakerStateChange: (breakerName, state) => {
    const stateValue = state === 'open' ? 1 : (state === 'halfOpen' ? 2 : 0);
    metrics.circuitBreakerState.set({ breaker_name: breakerName }, stateValue);
  },

  circuitBreakerLatency: (breakerName, duration) => {
    metrics.circuitBreakerLatency.observe({ breaker_name: breakerName }, duration / 1000);
  }
};

// Export metrics endpoint handler
const metricsHandler = async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error);
  }
};

module.exports = {
  register,
  metrics,
  recordMetrics,
  metricsHandler
};


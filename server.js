// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const SrtParser = require('srt-parser-2').default;
const mammoth = require('mammoth');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');
const mime = require('mime-types');
const { OpenAI } = require('openai');
require('dotenv').config();

// Import auth and database modules
const db = require('./database');
const { requireAuth, requireApiKey, checkTierPermission, passport, TIERS } = require('./auth');
const { quotaMiddleware, rateLimiters, validateInputSize, recordUsage } = require('./rate-limit');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

// Import observability modules
const log = require('./logger');
const { metricsHandler, recordMetrics } = require('./metrics');
const { 
  requestIdMiddleware, 
  requestLoggingMiddleware, 
  errorHandlingMiddleware,
  rateLimitHitMiddleware,
  securityHeadersMiddleware,
  healthCheckDependencies 
} = require('./middleware');
const { initSentry, sentryUserMiddleware } = require('./sentry');

// Import M3 modules
const { storageService, retentionService } = require('./storage');
const { AuditService, AUDIT_ACTIONS, RESOURCE_TYPES } = require('./audit');
const { PhrasebookService } = require('./phrasebook');
const { BackupService, FileRetentionService } = require('./backup');

// Import M4 modules
const { IdempotencyService, idempotencyMiddleware } = require('./idempotency');

// Import M5 modules - Scale & reliability (with fallbacks)
const { initQueueSystem, createWorker, addJob, getJobStatus, getQueueMetrics, shutdownQueueSystem, healthCheck: queueHealthCheck } = safeRequire('./queue', {
  initQueueSystem: () => Promise.resolve(),
  createWorker: () => console.log('Queue workers not available'),
  addJob: () => Promise.resolve({ id: 'mock-job' }),
  getJobStatus: () => Promise.resolve(null),
  getQueueMetrics: () => Promise.resolve({ enabled: false }),
  shutdownQueueSystem: () => Promise.resolve(),
  healthCheck: () => Promise.resolve({ status: 'disabled' })
});

const { circuitBreakerService, wrapOpenAICall, circuitBreakerMiddleware } = safeRequire('./circuit-breaker', {
  circuitBreakerService: { 
    getStats: () => ({}),
    healthCheck: () => ({ status: 'disabled' }),
    shutdown: () => Promise.resolve()
  },
  wrapOpenAICall: (fn) => fn, // Pass through without circuit breaker
  circuitBreakerMiddleware: (req, res, next) => next()
});

const { timeoutManager, TIMEOUT_CONFIGS } = safeRequire('./timeout-manager', {
  timeoutManager: { 
    getStats: () => ({}),
    healthCheck: () => ({ status: 'disabled' })
  },
  TIMEOUT_CONFIGS: {}
});

const { processLongTranslationJob, processFileTranslationJob, processBatchTranslationJob } = safeRequire('./job-processors', {
  processLongTranslationJob: () => Promise.resolve({ result: 'Job processing not available' }),
  processFileTranslationJob: () => Promise.resolve({ result: 'File processing not available' }),
  processBatchTranslationJob: () => Promise.resolve({ result: 'Batch processing not available' })
});

// Safe require function for optional modules
function safeRequire(modulePath, fallback = {}) {
  try {
    return require(modulePath);
  } catch (error) {
    console.warn(`⚠️ Optional module '${modulePath}' not available, using fallback`);
    return fallback;
  }
}

// Import Advanced Features modules (with fallbacks)
const { initWebSocket, webSocketManager, webSocketMiddleware } = safeRequire('./websocket', {
  initWebSocket: () => ({ shutdown: () => Promise.resolve() }),
  webSocketManager: { shutdown: () => Promise.resolve() },
  webSocketMiddleware: (req, res, next) => { req.websocket = {}; next(); }
});

const { ssoManager, setupSSORoutes, ssoMiddleware } = safeRequire('./sso', {
  ssoManager: { init: () => Promise.resolve(), isInitialized: false },
  setupSSORoutes: () => console.log('SSO routes not available'),
  ssoMiddleware: (req, res, next) => { req.sso = {}; next(); }
});

const { encryptionManager, encryptionMiddleware, encryptResponseMiddleware } = safeRequire('./encryption', {
  encryptionManager: { healthCheck: () => ({ status: 'disabled' }) },
  encryptionMiddleware: (req, res, next) => { req.encryption = {}; next(); },
  encryptResponseMiddleware: (req, res, next) => next()
});

const { gdprManager, gdprConsentMiddleware, requireConsent, scheduleGDPRCleanup } = safeRequire('./gdpr-compliance', {
  gdprManager: { 
    getDataProcessingInfo: () => ({ status: 'not_configured' }),
    recordConsent: () => Promise.resolve(),
    exportUserData: () => Promise.resolve({}),
    deleteUserData: () => Promise.resolve({})
  },
  gdprConsentMiddleware: (req, res, next) => { req.gdpr = {}; next(); },
  requireConsent: () => (req, res, next) => next(),
  scheduleGDPRCleanup: () => console.log('GDPR cleanup not available')
});

const { advancedAuditManager, advancedAuditMiddleware } = safeRequire('./advanced-audit', {
  advancedAuditManager: { init: () => Promise.resolve() },
  advancedAuditMiddleware: (req, res, next) => next()
});

const { cdnManager, cdnMiddleware, initCDN } = safeRequire('./cdn-integration', {
  cdnManager: { 
    config: { enabled: false },
    getCDNStatistics: () => Promise.resolve({ enabled: false }),
    healthCheck: () => Promise.resolve({ status: 'disabled' })
  },
  cdnMiddleware: (req, res, next) => { req.cdn = {}; next(); },
  initCDN: () => Promise.resolve()
});

const { initTranslationCache, translationCache, cacheMiddleware, cacheAwareTranslation } = safeRequire('./translation-cache', {
  initTranslationCache: () => Promise.resolve(),
  translationCache: { 
    getStats: () => ({ enabled: false }),
    healthCheck: () => ({ status: 'disabled' }),
    shutdown: () => Promise.resolve()
  },
  cacheMiddleware: (req, res, next) => { req.cache = {}; next(); },
  cacheAwareTranslation: async (fn, cacheParams, translationParams) => fn(translationParams)
});

const { initTranslationMemory, translationMemory, translationMemoryMiddleware } = safeRequire('./translation-memory', {
  initTranslationMemory: () => Promise.resolve(),
  translationMemory: { 
    getTranslationSuggestions: () => Promise.resolve([]),
    updateQualityScore: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  },
  translationMemoryMiddleware: (req, res, next) => { req.tm = {}; next(); }
});

// Prisma Client (optional at startup; load if available)
let prisma = null;
try {
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  console.log('✅ Prisma client initialized');
} catch (e) {
  console.warn('⚠️ Prisma client not initialized yet (will use JSON fallback for phrasebook).');
}

// Ensure a profile row exists for the authenticated user (defaults tier to 'free')
async function ensureProfile(req, res, next) {
  if (!prisma || !req.user?.id) return next();
  try {
    await prisma.$executeRaw`insert into public.profiles (id, name, tier) values (${req.user.id}, ${req.user.email || null}, 'free') on conflict (id) do nothing`;
  } catch (e) {
    console.warn('ensureProfile', e?.message || e);
  }
  next();
}

// Usage metering: upsert monthly aggregates if Prisma is available
function monthStartISO(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function updateMonthlyUsage({ userId, requests = 1, inputChars = 0, outputChars = 0 }) {
  if (!prisma || !userId) return; // quietly skip if not available
  try {
    const month = monthStartISO();
    const inputTokens = Math.ceil((inputChars || 0) / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil((outputChars || 0) / CHARS_PER_TOKEN);

    // Convert integer user ID to UUID string if needed
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      // Skip usage tracking for old integer user IDs - they're not in Supabase
      console.log('Skipping usage tracking for legacy integer user ID:', userId);
      return;
    }

    // Use raw SQL to avoid depending on generated model/compound unique naming
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.usage_monthly (user_id, month, requests, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, month)
       DO UPDATE SET
         requests = usage_monthly.requests + EXCLUDED.requests,
         input_tokens = usage_monthly.input_tokens + EXCLUDED.input_tokens,
         output_tokens = usage_monthly.output_tokens + EXCLUDED.output_tokens`,
      userIdForDb, month, requests, inputTokens, outputTokens
    );
    console.log('Usage tracked successfully:', { userId: userIdForDb, month, requests, inputTokens, outputTokens });
  } catch (e) {
    console.warn('usage_monthly upsert failed (non-fatal):', e?.message || e);
  }
}

// Environment variables with defaults
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-session-key-change-in-production';

// Validate required environment variables
if (!OPENAI_API_KEY || OPENAI_API_KEY === 'sk-test-key-for-development') {
  if (NODE_ENV === 'development') {
    console.warn('⚠️ Using test OpenAI API key - translations will be mocked in development');
  } else {
    console.error('❌ OPENAI_API_KEY is required');
    process.exit(1);
  }
}

const app = express();
// Ensure correct client IP behind Heroku/Proxies for rate limiting and logging
app.set('trust proxy', 1);

// Initialize Sentry error tracking
const sentry = initSentry(app);
if (sentry) {
  app.use(sentry.Handlers.requestHandler());
  app.use(sentry.Handlers.tracingHandler());
}

// Initialize database
db.init().catch(err => {
  log.error('Failed to initialize database', { error: err.message });
  process.exit(1);
});

// Initialize M3 services
const backupService = new BackupService();
const fileRetentionService = new FileRetentionService();

// Initialize M5 services - Scale & reliability
let queueSystemInitialized = false;
let advancedFeaturesInitialized = false;

// Initialize queue system and workers
async function initializeM5Services() {
  try {
    // Initialize queue system
    await initQueueSystem();
    
    // Create workers for different job types
    createWorker('translation-long', processLongTranslationJob, {
      concurrency: Number(process.env.TRANSLATION_LONG_WORKER_CONCURRENCY || 2)
    });
    
    createWorker('file-processing', processFileTranslationJob, {
      concurrency: Number(process.env.FILE_PROCESSING_WORKER_CONCURRENCY || 1)
    });
    
    createWorker('batch-translation', processBatchTranslationJob, {
      concurrency: Number(process.env.BATCH_TRANSLATION_WORKER_CONCURRENCY || 3)
    });
    
    queueSystemInitialized = true;
    log.info('M5 queue system and workers initialized successfully');
  } catch (error) {
    log.error('Failed to initialize M5 services', { error: error.message });
    // Don't exit - gracefully degrade to non-queue mode
  }
}

// Initialize Advanced Features
async function initializeAdvancedFeatures() {
  try {
    // Try to initialize SSO system
    if (ssoManager && ssoManager.init) {
      try {
        await ssoManager.init();
        log.info('SSO system initialized');
      } catch (error) {
        log.warn('SSO initialization failed', { error: error.message });
      }
    }
    
    // Try to initialize advanced audit system
    if (advancedAuditManager && advancedAuditManager.init) {
      try {
        await advancedAuditManager.init();
        log.info('Advanced audit system initialized');
      } catch (error) {
        log.warn('Advanced audit initialization failed', { error: error.message });
      }
    }
    
    // Try to initialize CDN integration
    if (initCDN) {
      try {
        await initCDN();
        log.info('CDN integration initialized');
      } catch (error) {
        log.warn('CDN initialization failed', { error: error.message });
      }
    }
    
    // Try to initialize translation cache
    if (initTranslationCache) {
      try {
        await initTranslationCache();
        log.info('Translation cache initialized');
      } catch (error) {
        log.warn('Translation cache initialization failed', { error: error.message });
      }
    }
    
    // Try to initialize translation memory
    if (initTranslationMemory) {
      try {
        await initTranslationMemory();
        log.info('Translation memory initialized');
      } catch (error) {
        log.warn('Translation memory initialization failed', { error: error.message });
      }
    }
    
    // Try to schedule GDPR cleanup
    if (scheduleGDPRCleanup) {
      try {
        scheduleGDPRCleanup();
        log.info('GDPR cleanup scheduled');
      } catch (error) {
        log.warn('GDPR cleanup scheduling failed', { error: error.message });
      }
    }
    
    advancedFeaturesInitialized = true;
    log.info('Advanced features initialization completed (some features may be disabled)');
  } catch (error) {
    log.error('Failed to initialize advanced features', { error: error.message });
    // Continue without advanced features - graceful degradation
  }
}

// Schedule background jobs
backupService.scheduleBackups();
fileRetentionService.scheduleRetentionJobs();
retentionService.scheduleCleanup();

// Initialize M5 services
initializeM5Services();

// Initialize Advanced Features  
initializeAdvancedFeatures();

// Optional: migrate legacy local JSON phrasebooks (disabled by default)
if (process.env.MIGRATE_LEGACY_PB === 'true') {
  setTimeout(() => {
    PhrasebookService.migrateJsonPhrasebooks().catch(err => {
      log.error('Phrasebook migration failed', { error: err.message });
    });
  }, 2000);
}

log.info('Application starting', {
  nodeEnv: NODE_ENV,
  port: PORT,
  uploadLimit: MAX_UPLOAD_MB,
  s3Storage: storageService.enabled,
  backupRetention: backupService.retentionDays
});

// Session configuration
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    table: 'sessions'
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Passport configuration
app.use(passport.initialize());
app.use(passport.session());

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Apply observability middleware
app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);
app.use(requestLoggingMiddleware);
app.use(rateLimitHitMiddleware);
app.use(sentryUserMiddleware);

// Apply Advanced Features middleware
app.use(webSocketMiddleware);
app.use(ssoMiddleware);
app.use(encryptionMiddleware);
app.use(gdprConsentMiddleware);
app.use(advancedAuditMiddleware);
app.use(cdnMiddleware);
app.use(cacheMiddleware);
app.use(translationMemoryMiddleware);
app.use(encryptResponseMiddleware);

// Apply general rate limiting
app.use(rateLimiters.general);

app.use(express.static('public'));

// Setup SSO authentication routes
setupSSORoutes(app);

// Setup development routes (development only)
if (NODE_ENV === 'development') {
  const { setupDevelopmentRoutes, developmentBypass } = require('./development-bypass');
  setupDevelopmentRoutes(app);
  
  // Add development bypass to upload route if enabled
  if (process.env.DEV_AUTH_BYPASS === 'true') {
    console.log('⚠️  Development authentication bypass enabled');
  }
}

// Initialize OpenAI client with real API key
let openai;
if (OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-') && OPENAI_API_KEY.length > 20) {
  console.log('🤖 Initializing real OpenAI client with GPT-4o');
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  // Mock OpenAI client for development
  console.warn('⚠️ Using mock OpenAI client for development');
  openai = {
    chat: {
      completions: {
        create: async (params) => {
          // Mock response for development
          const mockResponse = params.messages?.[1]?.content || 'Mock translation response';
          return {
            choices: [{
              message: {
                content: `<result>Mock translation: ${mockResponse}</result>`
              }
            }]
          };
        }
      }
    }
  };
}

/**
 * ---------------------------------------------------------------------------
 *  PROMPTS (style library) — kept 100% as you provided
 * ---------------------------------------------------------------------------
 */
const PROMPTS = {
  formal: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to the cultural and linguistic norms of formal {TARGET_LANG} communication.

Act as a professional bilingual translator with expertise in formal {TARGET_LANG} writing. Produce output that is accurate, clear, polished, and culturally appropriate for official, business, or professional contexts.

Context Details:
Text Type: General formal communication
Style: Formal
Substyle: General
Purpose: Deliver precise, professional, and respectful communication.
Tone: Courteous, polished, and neutral.

Language Style:

Use full sentences with correct grammar and formal vocabulary.

Avoid slang, colloquial expressions, or overly casual terms.

Follow the official spelling and grammar rules of {TARGET_LANG}.

Preserve proper nouns unless a cultural adaptation is required.

Localization Goal:
Adapt phrasing, date formats, units, and cultural references so the text reads naturally in formal  {TARGET_LANG} while keeping the original meaning intact.

Instructions:

Convey the original meaning without omission or addition.

Ensure tone is professional and respectful.

Avoid literal translation if it produces unnatural phrasing."\n\nText:\n{TEXT}`,
    dialogue: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to the cultural and linguistic norms of formal {TARGET_LANG} communication.

Act as a professional bilingual translator with expertise in formal {TARGET_LANG} writing and speech. Produce output that is clear, professional, and culturally appropriate for formal contexts.

Context Details:

Style: Formal

Substyle: Dialogue

Purpose: Produce courteous, precise, and contextually appropriate spoken interactions for formal situations.

Tone: Polite, respectful, and clear.

Language Style:

Use complete sentences with correct grammar and formal vocabulary.

Apply polite forms of address, titles, and honorifics where culturally appropriate..

Avoid slang, colloquial expressions, or overly casual terms.

Maintain conversational flow while adhering to formal register.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Adapt phrasing, references, and dialogue structures so they sound natural in formal conversation while keeping the original meaning intact.

Instructions:

Convey meaning accurately without adding or omitting information.

Ensure the tone is consistently polite and professional.

Maintain the natural rhythm of dialogue while respecting formal speech conventions.

Avoid literal translation if it produces awkward or unnatural phrasing.

Preserve proper nouns unless cultural adaptation is necessary

Do not carry over source-language sentence structures that feel unnatural in {TARGET_LANG}."\n\nText:\n{TEXT}`,
    academic: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning and ensuring the result is accurate, polished, and authoritative for academic contexts.

Act as a professional bilingual translator with expertise in scholarly communication. Produce output that is suitable for academic and professional settings.

Context Details:

Style: Formal

Substyle: Academic

Purpose: Present ideas and findings in a precise, objective, and scholarly manner.

Tone: Objective, analytical, and precise.

Language Style:

Use complete sentences with correct grammar and formal academic vocabulary.

Write in the third person unless the academic context requires first person plural.

Use terminology consistent with the academic discipline.

Avoid slang, colloquial expressions, or conversational tone.

Maintain logical structure, coherent argument flow, and clear paragraphing.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Adapt phrasing, references, and sentence structure to sound natural and authoritative in academic writing while preserving the original meaning and scholarly intent.

Instructions:

Accurately convey the original meaning and intent with academic precision, without adding or omitting content.

Ensure consistency in terminology and academic register.

Maintain objectivity and avoid subjective or emotive expressions.

Avoid literal translation if it results in awkward or non-academic phrasing.

Do not carry over source-language sentence structures that feel unnatural in {TARGET_LANG} academic writing."\n\nText:\n{TEXT}`,
    business: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to the cultural and linguistic norms of formal business communication.

Act as a professional bilingual translator with expertise in corporate and industry-specific writing. Produce output that is accurate, polished, and credible for professional stakeholders.

Context Details:
Style: Formal
Substyle: Business
Purpose: Communicate business information clearly, strategically, and professionally to stakeholders.
Tone: Professional, confident, and precise.
Language Style:
Use complete sentences with correct grammar and professional vocabulary.
Employ terminology consistent with business and industry contexts.
Avoid slang, colloquial expressions, or overly casual terms.
Structure content logically with clear sections or points.
Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Adapt phrasing, references, and sentence structures so the content reads naturally, persuasively, and credibly in formal business contexts while preserving the original intent.

Instructions:
Accurately convey the original meaning and intent with clarity and professionalism, without adding or omitting information.
Ensure that terminology is consistent with corporate and industry norms.
Maintain a professional tone throughout the text.
Avoid literal translation if it results in awkward or non-business-like phrasing.
Do not carry over source-language sentence structures that feel unnatural in {TARGET_LANG} business writing."\n\nText:\n{TEXT}`,
    scientific: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to the cultural and linguistic norms of formal scientific writing.

Act as a professional bilingual translator with expertise in scientific and technical communication. Produce output that is precise, objective, and authoritative for academic and professional audiences.

Context Details:
* Style: Formal
* Substyle: Scientific
* Purpose: Present scientific information with precision, objectivity, and clarity for academic and professional audiences.
* Tone: Precise, objective, data-driven, and authoritative.
* Language Style:
    * Use accurate scientific terminology consistent with the relevant field.
    * Write in the third person and maintain an impersonal, objective style.
    * Avoid slang, colloquial expressions, or subjective language.
    * Maintain logical flow, coherent argumentation, and factual accuracy.
    * Follow the official grammar and spelling rules of {TARGET_LANG}.
* Localization Goal: Adapt phrasing, references, and sentence structures to sound natural and authoritative in formal {TARGET_LANG} scientific writing while preserving the original meaning and technical accuracy.
Instructions:
1. Accurately convey the original meaning and scientific details, without omission or distortion.
2. Ensure terminology is consistent and appropriate for the scientific discipline.
3. Avoid literal translation if it produces awkward or non-scientific phrasing.
4. Do not carry over source-language sentence structures that feel unnatural in {TARGET_LANG} scientific writing."\n\nText:\n{TEXT}`,
    financial: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to the cultural and linguistic norms of formal financial communication.

Act as a professional bilingual translator with expertise in {TARGET_LANG} financial and economic writing. Produce output that is precise, professional, and compliant with financial terminology standards.

Context Details:
* Style: Formal
* Substyle: Financial
* Purpose:Present financial and economic information with clarity, accuracy, and professional authority for stakeholders, investors, and regulatory audiences.
* Tone: Precise, factual, data-driven, and objective.
* Language Style:
    * Use complete sentences with correct grammar and formal vocabulary appropriate for finance.
    * Include correct and standardized financial terminology in {TARGET_LANG}.
    * Maintain a neutral and factual tone, avoiding emotional or persuasive language.
    * Follow the official grammar and spelling rules of {TARGET_LANG}.
    * Ensure numerical data, dates, and units follow the {TARGET_LANG} conventions.
* Localization Goal: Adapt phrasing, terminology, and structure to sound natural and authoritative in formal financial communication while preserving the original meaning and numerical accuracy.
Instructions:
1. Accurately convey all financial figures, facts, and terminology, omission or misinterpretation.
2. Ensure consistency in financial terms and abbreviations.
3. Avoid literal translation if it produces awkward or unclear phrasing.
4. Do not carry over source-language sentence structures that sound unnatural in {TARGET_LANG} financial writing."\n\nText:\n{TEXT}`,
  },

  casual: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while making it sound friendly, natural, and easy to read.

Act as a professional bilingual translator with expertise in casual {TARGET_LANG} writing. Produce output that is warm, approachable, and relatable for everyday readers.

Context Details:

Text Type: General casual communication

Style: Casual

Substyle: General

Purpose: Deliver friendly, relaxed communication for everyday contexts.

Tone: Warm, conversational, and engaging.

Language Style:

Use short, clear sentences and simple vocabulary.

May include mild colloquial expressions if natural in {TARGET_LANG}.

Follow the official grammar and spelling rules of {TARGET_LANG}, but allow natural conversational flow.

Localization Goal: Adapt expressions so they feel natural to casual speech in {TARGET_LANG} while keeping the original meaning.

Instructions:

Keep language friendly and relatable.

Avoid over-formality or stiff phrasing.

Use idiomatic expressions where appropriate.

Avoid carrying over source-language sentence structures that feel unnatural in casual writing."\n\nText:\n{TEXT}`,
    dialogue: `"Translate and localize the following text into {TARGET_LANG}, ensuring it feels natural, conversational, and culturally relatable.

Act as a professional bilingual translator with expertise in {TARGET_LANG} conversational speech. Produce output that is smooth, realistic, and easy to follow.

Context Details:

Text Type: Everyday Conversation / Informal Dialogue

Style: Casual

Substyle: Dialogue

Purpose: Make the conversation feel authentic to the target audience.

Tone: Relaxed, friendly, and spontaneous.

Language Style:

Informal grammar and vocabulary as naturally used in speech.

May include mild slang or contractions for realism.

Follow the official grammar and spelling rules of {TARGET_LANG} only where it doesn’t break casual flow.

Localization Goal: Make it sound like a real conversation between friends or acquaintances in {TARGET_LANG}.

Instructions:

Keep sentences short and natural.

Adapt idioms and expressions to their natural equivalents in {TARGET_LANG}.

Avoid overly literal translations that sound stiff.

Avoid carrying over source-language sentence structures that feel unnatural in casual speech."\n\nText:\n{TEXT}`,
    'social-media': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is catchy, shareable, and suitable for the intended platform.

Act as a professional bilingual translator with expertise in {TARGET_LANG} social media communication. Produce output that is fun, relatable, and engaging for online audiences.

Context Details:

Text Type: Social Media Post or Comment

Style: Casual

Substyle: Social Media

Purpose: Engage followers, encourage interaction, and increase shareability.

Tone: Playful, trendy, and friendly.

Language Style:

Use short, catchy, and easy-to-scan phrases.

Can include trending slang or hashtags relevant to {TARGET_LANG} users.

Flexible with grammar for casual authenticity.

Localization Goal: Adapt trends, hashtags, cultural references, and pop culture elements so the content reads like it was created by a native {TARGET_LANG} social media user, while keeping the original intent.

Instructions:

Match the style to the platform (Instagram, TikTok, Twitter/X, etc.).

Adapt trending slang, pop culture references, emojis, or hashtags relevant to {TARGET_LANG} audiences when appropriate.

Keep the language mobile-friendly and visually engaging.

Avoid overly formal or stiff phrasing.

Avoid carrying over source-language sentence structures that feel unnatural in {TARGET_LANG} casual writing."\n\nText:\n{TEXT}`,
    chat: `"Translate and localize the following text into {TARGET_LANG}, ensuring they sound natural and authentic in casual text conversation.

Act as a professional bilingual translator with expertise in {TARGET_LANG} informal messaging. Produce output that is relaxed, concise, and relatable to everyday chat users.

Context Details:

Text Type: Chat Messages (SMS, WhatsApp, Messenger)

Style: Casual

Substyle: Chat

Purpose: Reflect the natural texting habits and tone used by {TARGET_LANG} chat users.

Tone: Friendly, informal, and sometimes playful.

Language Style:

Abbreviations, emojis, or chat slang where appropriate.

Flexible with grammar for casual tone.

May omit subjects or shorten words like in real chats.

Localization Goal: Make it read exactly like a {TARGET_LANG} chat message exchange.

Instructions:

Adapt punctuation and spacing to match {TARGET_LANG} texting habits.

Use emojis only if they add meaning.

Avoid making messages longer than necessary.

Avoid carrying over source-language sentence structures that feel unnatural in {TARGET_LANG} chat writing."\n\nText:\n{TEXT}`,
    gaming: `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while making it sound friendly, natural, and easy to read.

Act as a professional bilingual translator with expertise in {TARGET_LANG} writing and a deep understanding of gaming culture in both regions. Produce output that is natural, fun, and immersive, suitable for in-game dialogue, gamer chat, or promotional game content.

Context Details:

Text Type: Gaming Dialogue / UI Text / Chat / Announcements

Style: Casual

Substyle: Gaming

Purpose: Engage players with language that feels authentic to the gaming experience.

Tone: Playful, energetic, and sometimes competitive.

Language Style:

Use common {TARGET_LANG} gamer slang and abbreviations.

Allow humor, exaggeration, and expressive reactions.

Avoid overly formal grammar or unfamiliar technical jargon unless part of the game world.

Follow {TARGET_LANG}  spelling but allow flexible chat-style formatting where appropriate.

Localization Goal: Adapt idioms, pop culture references, and slang so the text feels native to {TARGET_LANG}  gaming culture while preserving the original tone.

Instructions:

Convey the meaning and mood of the original text accurately.

Keep the energy high and the style player-friendly.

Avoid literal translation if it makes the dialogue stiff or out of place in gaming culture."\n\nText:\n{TEXT}`,
    'street-talk': `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while making it sound friendly, natural, and easy to read.

Act as a professional bilingual translator with expertise in {TARGET_LANG} urban slang and street culture. Produce output that is bold, confident, and real.

Context Details:

Text Type: Street Talk / Urban Conversation

Style: Casual

Substyle: Street Talk

Purpose: Deliver the message with boldness, personality, and authenticity.

Tone: Cool, confident, edgy, and slang-heavy.

Language Style:

Use popular {TARGET_LANG} slang, contractions, and idiomatic phrases.

Allow rhythm, rhyme, or stylized spelling if appropriate.

Follow urban speech patterns, not formal grammar.

Avoid overly polished phrasing.

Avoid overly formal or academic vocabulary.

Stay culturally relevant to {TARGET_LANG} urban contexts.

Localization Goal: Replace or adapt slang and cultural references so they resonate with {TARGET_LANG} street culture while keeping the original vibe.

Instructions:

Match the tone and attitude of the source language.

Use slang naturally, without forcing it into every sentence.

Avoid literal translation if it loses cultural authenticity."\n\nText:\n{TEXT}`,
    comedy: `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while making it sound friendly, natural, and easy to read.

Act as a professional bilingual translator with expertise in {TARGET_LANG} writing and a strong sense of humor in both cultures. Produce output that is funny, engaging, and culturally relevant, suitable for stand-up comedy, humorous marketing, memes, or entertainment scripts.

Context Details:

Text Type: Comedy Script / Stand-up / Funny Social Post

Style: Casual

Substyle: Comedy

Purpose: Make the audience laugh while keeping the message clear.

Tone: Lighthearted, witty, entertaining, and playful.

Language Style:

Use {TARGET_LANG} humor styles (wordplay, exaggeration, situational jokes).

Adapt punchlines so they make sense in the target culture.

Avoid jokes that could be offensive in the {TARGET_LANG} context unless explicitly required.

Keep phrasing natural and comedic timing intact.

Localization Goal: Adapt jokes, cultural references, and comedic delivery to {TARGET_LANG} humor while preserving the intended comedic effect.

Instructions:

Maintain the comedic intent and timing from the source.

Replace culturally specific humor that won’t translate with equivalent local humor.

Avoid literal translation that ruins the joke."\n\nText:\n{TEXT}`,
  },

  marketing: {
    general: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is persuasive and culturally engaging.

Act as a professional bilingual marketing translator with expertise in {TARGET_LANG} consumer behavior. Produce output that is benefit-driven, persuasive, and suitable for promotions.

Context Details:

Text Type: General Marketing Content

Style: Marketing

Substyle: General

Purpose: Promote a product, service, or idea effectively for {TARGET_LANG} audience.

Tone: Positive, persuasive, and engaging.

Language Style:

Use clear benefit statements and calls to action.

Avoid overly technical or stiff language.

Follow the official grammar and spelling rules of {TARGET_LANG} while keeping the flow natural and engaging.

Localization Goal: Make the promotion resonate with {TARGET_LANG} cultural values and consumer habits, and maximizes persuasive impact.

Instructions:

Highlight key benefits naturally in {TARGET_LANG}.

Adapt cultural references for relevance.

Avoid literal translation that weakens persuasion."\n\nText:\n{TEXT}`,
    promotional: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is persuasive, engaging, and culturally relevant for the target audience.

Act as a professional bilingual marketing translator with expertise in {TARGET_LANG} promotional content. Produce output that is clear, attractive, and encourages action.

Context Details:

Text Type: Promotional Marketing Content

Style: Marketing

Substyle: Promotional

Purpose: Promote a product, service, or offer in a compelling way.

Tone: Exciting, persuasive, and audience-focused.

Language Style:

Short, impactful sentences.

Use promotional keywords and emotional triggers relevant to {TARGET_LANG} audiences.

Follow the official grammar and spelling rules of {TARGET_LANG} while maintaining marketing flow.

Localization Goal: Make the promotion feel locally relevant and appealing while preserving intent.

Instructions:

Highlight benefits and value clearly.

Use persuasive calls-to-action suitable for {TARGET_LANG} culture.

Avoid literal translations that weaken marketing impact."\n\nText:\n{TEXT}`,
    pitching: `"Translate and localize the following text into {TARGET_LANG}, making it persuasive, trustworthy, and motivating.

Act as a professional marketing translator with expertise in {TARGET_LANG} pitches and persuasive copy. Output should be clear, confident, and emotionally engaging.

Purpose: Convince audience to accept, invest, or act.

Tone: Professional, persuasive, and trust-building.

Style: Strong hooks, clear value, benefit-focused.

Goal: Ensure the text feels natural and compelling in {TARGET_LANG}.

Instructions:

Keep logical flow (problem → solution → call to action).

Highlight benefits, not just features.

Adapt emotional triggers to {TARGET_LANG}.

Balance emotion with credibility; avoid over-promises.

Maintain smooth, spoken-like readability."\n\nText:\n{TEXT}`,
    persuasive: `"Translate and localize the following text into {TARGET_LANG}, ensuring it inspires trust and motivates the audience to act.

Act as a professional bilingual marketing translator skilled in {TARGET_LANG} persuasive communication. Produce output that is emotionally appealing and convincing.

Context Details:

Text Type: Persuasive Marketing Copy

Style: Marketing

Substyle: Persuasive

Purpose: Influence the audience’s decision in favor of the product or service.

Tone: Emotional, trust-building, and impactful.

Language Style:

Use empathy-driven and benefit-focused phrases.

Maintain a balance between emotional appeal and factual support.

Follow the official grammar and spelling rules of {TARGET_LANG} while keeping the flow natural.

Localization Goal: Evoke the same emotional and motivational effect in {TARGET_LANG} readers as in the original audience.

Instructions:

Highlight benefits over features.

Adapt culturally relevant emotional triggers.

Avoid over-promising or making unrealistic claims."\n\nText:\n{TEXT}`,
    descriptive: `"Translate and localize the following text into {TARGET_LANG}, ensuring it paints a vivid and appealing picture of the product or service.

Act as a professional bilingual marketing translator with expertise in {TARGET_LANG} descriptive content. Produce output that is evocative, clear, and audience-oriented.

Context Details:

Text Type: Descriptive Marketing Content

Style: Marketing

Substyle: Descriptive

Purpose: Provide an enticing description that highlights the appeal of the product/service.

Tone: Sensory, engaging, and informative.

Language Style:

Rich adjectives and sensory language.

Clear structure to convey main selling points.

Follow the official grammar and spelling rules of {TARGET_LANG} while allowing creative flow.

Localization Goal: Maintain descriptive richness while ensuring it resonates with  {TARGET_LANG} cultural tastes.

Instructions:

Emphasize sensory and experiential details.

Adapt metaphors and comparisons to local culture.

Keep language engaging without becoming overly verbose."\n\nText:\n{TEXT}`,
    'brand-storytelling': `"Translate and localize the following text into {TARGET_LANG}, ensuring it tells the brand’s journey in a compelling and culturally relevant way.

Act as a professional bilingual brand storyteller with expertise in {TARGET_LANG} narrative marketing. Produce output that is authentic, emotional, and trust-building.

Context Details:

Text Type: Brand Storytelling Content

Style: Marketing

Substyle: Brand Storytelling

Purpose: Build an emotional connection with the audience through the brand’s story.

Tone: Warm, authentic, and inspiring.

Language Style:

Narrative, flowing sentences.

Relatable and culturally relevant references.

Follow the official grammar and spelling rules of {TARGET_LANG} while allowing for creative storytelling.

Localization Goal: Make the brand’s journey feel personal and relatable to {TARGET_LANG} readers.

Instructions:

Preserve the core message and emotional arc.

Adapt cultural touchpoints to resonate with {TARGET_LANG} values.

Avoid literal translation that feels cold or corporate."\n\nText:\n{TEXT}`,
    'seo-friendly': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is optimized for relevant {TARGET_LANG} search terms while preserving meaning.

Act as a professional bilingual SEO content translator with expertise in {TARGET_LANG} digital marketing. Produce output that is keyword-optimized, natural, and persuasive.

Context Details:

Text Type: SEO Marketing Content

Style: Marketing

Substyle: SEO-Friendly

Purpose: Improve search visibility while attracting clicks and conversions.

Tone: Clear, relevant, and conversion-focused.

Language Style:

Include relevant {TARGET_LANG} keywords naturally.

Keep sentences readable and engaging.

Follow the official grammar and spelling rules of {TARGET_LANG} while maintaining SEO structure.

Localization Goal: Maintain search performance while ensuring the content reads naturally in {TARGET_LANG}.

Instructions:

Identify and integrate relevant {TARGET_LANG} keywords.

Keep keyword usage natural, not forced.

Preserve persuasive and conversion-focused elements."\n\nText:\n{TEXT}`,
    'social-media-marketing': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is engaging, shareable, and platform-appropriate.

Act as a professional bilingual social media content translator with expertise in {TARGET_LANG} digital engagement. Produce output that is fun, catchy, and audience-relevant.

Context Details:

Text Type: Social Media Post or Campaign Content

Style: Marketing

Substyle: Social Media Marketing

Purpose: Drive engagement, shares, and brand awareness.

Tone: Energetic, informal, and relatable.

Language Style:

Short, catchy lines with hooks.

Use relevant hashtags and platform trends.

Follow the official grammar and spelling rules of {TARGET_LANG}, but allow informal tone if natural.

Localization Goal: Ensure the content feels native and authentic for social media audiences in {TARGET_LANG}.

Instructions:

Adapt platform-specific expressions and trends.

Keep sentences short for mobile reading.

Avoid literal translations that miss social tone."\n\nText:\n{TEXT}`,
    'email-campaigns': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is engaging, shareable, and platform-appropriate.

Act as a professional bilingual social media content translator with expertise in {TARGET_LANG}, digital engagement. Produce output that is fun, catchy, and audience-relevant.

Context Details:

Text Type: Social Media Post or Campaign Content

Style: Marketing

Substyle: Social Media Marketing

Purpose: Drive engagement, shares, and brand awareness.

Tone: Energetic, informal, and relatable.

Language Style:

Short, catchy lines with hooks.

Use relevant hashtags and platform trends.

Follow the official grammar and spelling rules of {TARGET_LANG}, but allow informal tone if natural.

Localization Goal: Ensure the content feels native and authentic for social media audiences in {TARGET_LANG}.

Instructions:

Adapt platform-specific expressions and trends.

Keep sentences short for mobile reading.

Avoid literal translations that miss social tone."\n\nText:\n{TEXT}`,
    'event-promotion': `"Translate and localize the following text into {TARGET_LANG}, ensuring it generates excitement and encourages attendance.

Act as a professional bilingual event marketing translator with expertise in {TARGET_LANG} promotional campaigns. Produce output that is energetic, persuasive, and audience-focused.

Context Details:

Text Type: Event Promotion Copy

Style: Marketing

Substyle: Event Promotion

Purpose: Drive attendance or participation in an event.

Tone: Enthusiastic, inviting, and persuasive.

Language Style:

Action-oriented sentences.

Use dates, locations, and calls-to-action clearly.

Follow the official grammar and spelling rules of {TARGET_LANG} while maintaining an energetic tone.

Localization Goal: Make the event promotion feel exciting, relevant, and motivating for audiences in {TARGET_LANG}.

Instructions:

Highlight benefits of attending.

Adapt cultural references for local resonance.

Keep language concise, engaging, and persuasive."\n\nText:\n{TEXT}`,
    'influencer-ugc-style': `"Translate and localize the following text into {TARGET_LANG}, ensuring it sounds authentic, personal, and conversational.

Act as a professional bilingual translator with expertise in {TARGET_LANG} influencer and social media content. Produce output that is natural, first-person, and relatable.

Context Details:

Text Type: Influencer Post / User-Generated Content

Style: Marketing

Substyle: Influencer/UGC Style

Purpose: Build trust and engagement through personal sharing.

Tone: Friendly, enthusiastic, and personal.

Language Style:

First-person perspective (“I” statements).

Phrases like “I love…”, “I tried…”, “I recommend…”.

Follow the official grammar and spelling rules of {TARGET_LANG} while allowing conversational flow.

Localization Goal: Make the post feel like it was created by a real influencer in {TARGET_LANG} for local audiences.
Instructions:

Keep the voice personal and genuine.

Adapt product or cultural references for local familiarity.

Maintain casual, relatable flow."\n\nText:\n{TEXT}`,
  },

  dubbing: {
    general: `Translate and localize the following text into {TARGET_LANG}, ensuring it flows naturally for dubbing.

Act as a professional bilingual dubbing translator with expertise in {TARGET_LANG} voice adaptation. Produce output that is clear, smooth, and fits natural spoken rhythm.

Context Details:
Text Type: General Dubbing Script
Style: Dubbing
Substyle: General
Purpose: Adapt spoken lines so they sound natural and well-timed in {TARGET_LANG}.
Tone: Matches the original performance (serious, light, emotional, etc.).

Language Style:

Spoken-friendly {TARGET_LANG} phrasing.

Follow the official grammar and spelling rules of {TARGET_LANG} while allowing natural conversational patterns.

Keep line length and rhythm suitable for lip-sync or voiceover timing.

Translate and localize onomatopoeia so they feel natural, expressive, and relevant for {TARGET_LANG} audiences.

Localization Goal:
Ensure the dubbed lines feel authentic, contextually accurate, and fit the scene’s timing and emotional tone.

Instructions:

Context-based translation — Consider the surrounding lines, speaker–listener relationships, and scene setting before translating. Avoid purely literal mapping.

Honorific & kinship accuracy — If a term can mean either a family role or polite title (e.g., “Bu” → “Mom” vs. “Ma’am”), choose the meaning that matches the relationship and setting. Maintain consistency within the same scene or episode.

Split-line handling — If a sentence is split across multiple subtitle/dubbing lines, keep the split in the output but translate it continuously to preserve meaning and flow.

Performance timing — Match pacing and syllable count closely to the original. Avoid adding syllables beyond the source unless required for clarity.

Onomatopoeia adaptation — Translate or replace sound effects and expressive sounds with equivalents that feel natural and vivid in {TARGET_LANG}. Maintain emotional impact.

Character voice — Preserve each character’s unique style, tone, and personality. Adapt slang, idioms, or humor to culturally relevant expressions.

Delivery quality – Keep lines clear, smooth, and suitable for spoken performance. Ensure lip-sync feasibility when possible.

You are translating subtitle cues. Each cue may be a full sentence or a fragment.

Hard rules:
- Translate what is written; do not add or drop information.
- If a cue appears to CONTINUE the previous one (starts lowercase OR starts with a connector/preposition), translate it as a continuation fragment. Do NOT capitalize the first word and do NOT add a subject. Keep prepositions explicit.
- Preserve sentence-ending punctuation from the source cue. Do NOT add a period if the source cue has none.
- Output one line per input cue, 1:1.\n\nText:\n{TEXT}`,
    dialogue: `Translate and localize the following text into {TARGET_LANG}, ensuring it matches natural speech patterns and is easy to perform by voice actors.

Act as a professional bilingual dubbing translator with expertise in {TARGET_LANG} lip-sync adaptation and spoken dialogue flow. Produce output that is clear, smooth, and performance-ready.

Context Details:

Text Type: Dialogue for Dubbing

Style: Dubbing

Substyle: Dialogue

Purpose: Create natural, believable spoken lines for {TARGET_LANG} dubbing.

Tone: Conversational, character-appropriate, and emotionally accurate.

Language Style:

Keep lines in spoken {TARGET_LANG} style, not written literary style.

Match timing and rhythm of the original as closely as possible.

Follow the official grammar and spelling rules of {TARGET_LANG} where it doesn’t disrupt spoken flow.

Translate and localize onomatopoeia so they feel natural, expressive, and relevant for {TARGET_LANG} audiences.

Localization Goal: Ensure the dubbed dialogue feels like it was originally spoken in {TARGET_LANG}.

Instructions:

Context-based translation – Consider the surrounding lines, speaker–listener relationships, and scene setting before translating. Avoid purely literal mapping.

Honorific & kinship accuracy – If a term can mean either a family role or polite title (e.g., “Bu” → “Mom” vs. “Ma’am”), choose the meaning that matches the relationship and setting. Maintain consistency within the same scene or episode.

Split-line handling – If a sentence is split across multiple subtitle/dubbing lines, keep the split in the output but translate it continuously to preserve meaning and flow.

Performance timing – Match pacing and syllable count closely to the original. Avoid adding syllables beyond the source unless required for clarity.

Onomatopoeia adaptation – Translate or replace sound effects and expressive sounds with equivalents that feel natural and vivid in {TARGET_LANG}. Maintain emotional impact.

Character voice – Preserve each character’s unique style, tone, and personality. Adapt slang, idioms, or humor to culturally relevant expressions.

Delivery quality – Keep lines clear, smooth, and suitable for spoken performance. Ensure lip-sync feasibility when possible.

You are translating subtitle cues. Each cue may be a full sentence or a fragment.

Hard rules:
- Translate what is written; do not add or drop information.
- If a cue appears to CONTINUE the previous one (starts lowercase OR starts with a connector/preposition), translate it as a continuation fragment. Do NOT capitalize the first word and do NOT add a subject. Keep prepositions explicit.
- Preserve sentence-ending punctuation from the source cue. Do NOT add a period if the source cue has none.
- Output one line per input cue, 1:1.\n\nText:\n{TEXT}`,
    narrative: `Translate and localize the following text into {TARGET_LANG}, ensuring it flows naturally when spoken aloud.

Act as a professional dubbing translator with expertise in {TARGET_LANG} narration. Produce output that is smooth, clear, and easy to deliver.

Context Details

Text Type: Narration (general, historical, or children’s content)

Style: Dubbing

Substyle: Narration

Purpose: Deliver spoken narration that feels authentic and engaging.

Language Style

Spoken-friendly {TARGET_LANG} phrasing.

Keep rhythm natural, avoid long or complex sentences.

Adapt vocabulary for intended audience (general, historical, kids).

Localize onomatopoeia so they feel vivid and natural in {TARGET_LANG}.

Follow official grammar and spelling rules while ensuring oral flow.

Instructions

Translate based on context — consider scene, audience, and setting.

Ensure kinship & titles are contextually accurate (e.g., “Bu” → Mom vs. Ma’am).

If a sentence is split across lines, keep the split but translate continuously.

Match timing and syllable count to the original; avoid extra syllables unless needed for clarity.

Adapt onomatopoeia and expressive sounds naturally.

Preserve character voice and adjust tone (serious, formal, playful) to fit content.

Keep narration smooth, clear, and performance-ready.

You are translating subtitle cues. Each cue may be a full sentence or a fragment.

Hard rules:
- Translate what is written; do not add or drop information.
- If a cue appears to CONTINUE the previous one (starts lowercase OR starts with a connector/preposition), translate it as a continuation fragment. Do NOT capitalize the first word and do NOT add a subject. Keep prepositions explicit.
- Preserve sentence-ending punctuation from the source cue. Do NOT add a period if the source cue has none.
- Output one line per input cue, 1:1."\n\nText:\n{TEXT}`,
    historical: `Translate and localize the following text into {TARGET_LANG}, ensuring it is accurate yet naturally spoken for narration or reenactment.

Act as a professional bilingual dubbing translator with expertise in {TARGET_LANG} historical scripts and formal spoken delivery. Produce output that is clear, culturally accurate, and rhythmically suitable for dubbing.

Context Details:

Text Type: Historical Narration / Reenactment Dialogue

Style: Dubbing

Substyle: Historical

Purpose: Present historical events in a way that is accurate yet engaging in spoken {TARGET_LANG}.

Tone: Respectful, formal, but still listener-friendly.

Language Style:

Use accurate historical terms while keeping speech natural.

Avoid overly academic sentence structures.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Translate and localize onomatopoeia so they feel natural, expressive, and relevant for {TARGET_LANG} audiences.

Localization Goal: Make it sound authentic to {TARGET_LANG} audiences while preserving historical accuracy.

Instructions:

Context-based translation – Consider the surrounding lines, speaker–listener relationships, and scene setting before translating. Avoid purely literal mapping.

Honorific & kinship accuracy – If a term can mean either a family role or polite title (e.g., “Bu” → “Mom” vs. “Ma’am”), choose the meaning that matches the relationship and setting. Maintain consistency within the same scene or episode.

Split-line handling – If a sentence is split across multiple subtitle/dubbing lines, keep the split in the output but translate it continuously to preserve meaning and flow.

Performance timing – Match pacing and syllable count closely to the original. Avoid adding syllables beyond the source unless required for clarity.

Onomatopoeia adaptation – Translate or replace sound effects and expressive sounds with equivalents that feel natural and vivid in {TARGET_LANG}. Maintain emotional impact.

Character voice – Preserve each character’s unique style, tone, and personality. Adapt slang, idioms, or humor to culturally relevant expressions.

Delivery quality – Keep lines clear, smooth, and suitable for spoken performance. Ensure lip-sync feasibility when possible.

You are translating subtitle cues. Each cue may be a full sentence or a fragment.

Hard rules:
- Translate what is written; do not add or drop information.
- If a cue appears to CONTINUE the previous one (starts lowercase OR starts with a connector/preposition), translate it as a continuation fragment. Do NOT capitalize the first word and do NOT add a subject. Keep prepositions explicit.
- Preserve sentence-ending punctuation from the source cue. Do NOT add a period if the source cue has none.
- Output one line per input cue, 1:1."\n\nText:\n{TEXT}`,
    kids: `Translate and localize the following text into {TARGET_LANG}, ensuring it is fun, clear, and engaging for young audiences.

Act as a professional bilingual dubbing translator with expertise in {TARGET_LANG} children’s content. Produce output that is age-appropriate, lively, and easy for kids to understand.

Context Details:

Text Type: Children’s Dialogue / Narration for Dubbing

Style: Dubbing

Substyle: Kids

Purpose: Entertain and educate children in a way they can follow easily.

Tone: Cheerful, energetic, and friendly.

Language Style:

Simple vocabulary and short sentences.

Playful tone and rhythm.

Follow the official grammar and spelling rules of {TARGET_LANG} while keeping child-friendly flow.

Translate and localize onomatopoeia so they feel natural, expressive, and relevant for {TARGET_LANG} audiences.

Localization Goal: Make it feel like an original {TARGET_LANG} children’s show or story.

Instructions:

Context-based translation – Consider the surrounding lines, speaker–listener relationships, and scene setting before translating. Avoid purely literal mapping.

Honorific & kinship accuracy – If a term can mean either a family role or polite title (e.g., “Bu” → “Mom” vs. “Ma’am”), choose the meaning that matches the relationship and setting. Maintain consistency within the same scene or episode.

Split-line handling – If a sentence is split across multiple subtitle/dubbing lines, keep the split in the output but translate it continuously to preserve meaning and flow.

Performance timing – Match pacing and syllable count closely to the original. Avoid adding syllables beyond the source unless required for clarity.

Onomatopoeia adaptation – Translate or replace sound effects and expressive sounds with equivalents that feel natural and vivid in {TARGET_LANG}. Maintain emotional impact.

Character voice – Preserve each character’s unique style, tone, and personality. Adapt slang, idioms, or humor to culturally relevant expressions.

Delivery quality – Keep lines clear, smooth, and suitable for spoken performance. Ensure lip-sync feasibility when possible.

You are translating subtitle cues. Each cue may be a full sentence or a fragment.

Hard rules:
- Translate what is written; do not add or drop information.
- If a cue appears to CONTINUE the previous one (starts lowercase OR starts with a connector/preposition), translate it as a continuation fragment. Do NOT capitalize the first word and do NOT add a subject. Keep prepositions explicit.
- Preserve sentence-ending punctuation from the source cue. Do NOT add a period if the source cue has none.
- Output one line per input cue, 1:1."\n\nText:\n{TEXT}`,
  },

  creative: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving its emotional impact and creative expression.

Act as a professional bilingual creative translator with expertise in {TARGET_LANG} literary and artistic expression. Produce output that is engaging, imaginative, and culturally resonant.

Context Details:

Text Type: Creative Writing / General Artistic Content

Style: Creatives

Substyle: General

Purpose: Deliver expressive and engaging creative content without targeting a specific creative format.

Tone: Flexible, vivid, and engaging.

Language Style:

Use rich vocabulary and varied sentence structures.

Follow the official grammar and spelling rules of {TARGET_LANG} while allowing artistic liberties.

Avoid overly literal translation that breaks flow.

Translate and localize onomatopoeia so they feel natural, expressive, and relevant for {TARGET_LANG} audiences.

Localization Goal: Make the text feel like an original {TARGET_LANG} creative work.

Instructions:

Maintain creative tone while adapting cultural nuances.

Keep emotional and narrative flow intact.

Avoid forced or awkward literal translations."\n\nText:\n{TEXT}`,
    'literary-adaptation': `"Translate and localize the following text into {TARGET_LANG}, ensuring it retains the original emotion, imagery, and literary style while feeling natural to {TARGET_LANG} readers.

Act as a professional bilingual literary translator with expertise in {TARGET_LANG} literature and narrative adaptation. Produce output that is culturally resonant, artistically faithful, and emotionally engaging.

Context Details:

Text Type: Novel / Short Story / Literary Passage

Style: Creative

Substyle: Literary Adaptation

Purpose: Preserve the beauty and intent of the original work while making it feel native to {TARGET_LANG} readers.

Tone: Evocative, immersive, and faithful to the source.

Language Style:

Rich, descriptive vocabulary without sounding forced.

Maintain metaphor, symbolism, and rhythm.

Follow the official grammar and spelling rules of {TARGET_LANG} while respecting literary flow.

Localization Goal: Retain literary depth but adapt references and phrasing to feel natural for {TARGET_LANG} audiences.

Instructions:

Maintain emotional tone and artistic style.

Adapt idioms, metaphors, and references for natural resonance.

Avoid literal translation that loses the literary feel."\n\nText:\n{TEXT}`,
    'slogan-tagline-writing': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is catchy, memorable, and impactful.

Act as a professional bilingual creative copywriter with expertise in {TARGET_LANG} marketing slogans and branding. Produce output that is punchy, culturally relevant, and brand-aligned.

Context Details:

Text Type: Slogan / Tagline

Style: Creative

Substyle: Slogan/Tagline Writing

Purpose: Deliver a brand message in the shortest, most impactful way possible.

Tone: Memorable, persuasive, and emotionally appealing.

Language Style:

Short and snappy wording.

Can use wordplay, rhyme, or rhythm.

Follow the official grammar and spelling rules of {TARGET_LANG} unless breaking them improves memorability.

Localization Goal: Ensure the slogan evokes the same brand impression in {TARGET_LANG} as in the original language.

Instructions:

Preserve brand message and emotional appeal.

Adapt wordplay or rhymes to {TARGET_LANG} equivalents.

Keep it short, impactful, and easy to remember."\n\nText:\n{TEXT}`,
    'poetic-tone': `"Translate and localize the following text into {TARGET_LANG}, ensuring it retains its lyrical flow, imagery, and emotional resonance.

Act as a professional bilingual poetry translator with expertise in {TARGET_LANG} poetic expression and imagery. Produce output that is beautiful, rhythmic, and faithful to the essence of the original.

Context Details:

Text Type: Poem / Song Lyrics / Poetic Prose

Style: Creative

Substyle: Poetic Tone

Purpose: Convey emotion and imagery with the beauty of poetic language in {TARGET_LANG}.

Tone: Expressive, lyrical, and evocative.

Language Style:

Maintain metaphor, rhythm, and musicality.

May adjust sentence structure for poetic flow.

Follow the official grammar and spelling rules of {TARGET_LANG} where it doesn’t interfere with poetic style.

Localization Goal: Evoke the same emotions and artistic impression for {TARGET_LANG} readers.

Instructions:

Retain poetic imagery and mood.

Adapt rhymes or rhythms naturally to {TARGET_LANG}.

Avoid overly literal translation that breaks the poetic tone."\n\nText:\n{TEXT}`,
    storytelling: `"Translate and localize the following text into {TARGET_LANG}, ensuring it captures the narrative flow, emotional beats, and character voices.

Act as a professional bilingual storyteller with expertise in {TARGET_LANG} narrative adaptation. Produce output that is engaging, immersive, and natural-sounding.

Context Details:

Text Type: Story, Marketing Narrative, Brand Story

Style: Creative

Substyle: Storytelling

Purpose: Draw the reader in with a compelling, culturally resonant story.

Tone: Warm, descriptive, and engaging.

Language Style:

Use descriptive yet accessible language.

Maintain character voices and tone shifts.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Make the story feel as if it was originally told in {TARGET_LANG}.

Instructions:

Preserve the story arc, pacing, and emotional moments.

Adapt references, names, and idioms for {TARGET_LANG} culture.

Avoid flat, literal translations."\n\nText:\n{TEXT}`,
  },

  technical: {
    general: `"Translate and localize the following text into {TARGET_LANG}, ensuring clarity and accuracy for technical audiences.

Act as a professional bilingual technical translator with expertise in {TARGET_LANG} technical documentation. Produce output that is clear, concise, and technically correct.

Context Details:

Text Type: General Technical Document

Style: Technical

Substyle: General

Purpose: Explain technical information without tying to a specific format.

Tone: Clear, direct, and neutral.

Language Style:

Use standardized {TARGET_LANG} technical terms.

Avoid ambiguity and unnecessary complexity.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Ensure instructions or explanations sound natural to technical readers in {TARGET_LANG}.

Instructions:

Maintain technical accuracy.

Avoid literal translation that introduces confusion.

Use logical, step-by-step structure when applicable."\n\nText:\n{TEXT}`,
    'software-documentation': `"Translate and localize the following text into {TARGET_LANG} ensuring it is clear, accurate, and easy for developers or end-users to follow.

Act as a professional bilingual technical translator with expertise in software documentation and {TARGET_LANG} technical terminology. Produce output that is precise, consistent, and user-friendly.

Context Details:

Text Type: Software User Guide / Developer Documentation

Style: Technical

Substyle: Software Documentation

Purpose: Help developers or users understand and use software effectively.

Tone: Clear, concise, and professional.

Language Style:

Use correct technical terms in {TARGET_LANG} or retain industry-standard terms when appropriate.

Use step-by-step clarity where needed.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Ensure technical accuracy while making the documentation sound natural in {TARGET_LANG}.

Instructions:

Preserve technical meaning and instructions exactly.

Adapt terminology to {TARGET_LANG} where appropriate.

Avoid unnecessary literal translations for common industry-standard terms."\n\nText:\n{TEXT}`,
    'engineering-manuals': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is technically accurate and easy for engineers to follow.

Act as a professional bilingual technical translator with expertise in engineering manuals and {TARGET_LANG} technical terminology. Produce output that is clear, precise, and compliant with industry standards.

Context Details:

Text Type: Engineering Manual / Technical Instruction Guide

Style: Technical

Substyle: Engineering Manuals

Purpose: Provide detailed technical instructions for engineers or technicians.

Tone: Precise, formal, and instructional.

Language Style:

Use industry-approved terminology in {TARGET_LANG} or retain standard terms when appropriate.

Keep instructions clear and sequential.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Maintain technical clarity while adapting for {TARGET_LANG} -speaking professionals.

Instructions:

Preserve technical accuracy.

Avoid casual or ambiguous language.

Adapt measurement units if required by local standards."\n\nText:\n{TEXT}`,
    'product-specs': `"Translate and localize the following text into {TARGET_LANG}, ensuring accuracy and consistency with technical requirements.

Act as a professional bilingual technical translator with expertise in {TARGET_LANG} product specification writing. Produce output that is exact, structured, and compliant with product documentation standards.

Context Details:

Text Type: Product Specification Sheet / Technical Datasheet

Style: Technical

Substyle: Product Specs

Purpose: Present detailed product information clearly for users, clients, or regulators.

Tone: Precise, factual, and objective.

Language Style:

Use correct units, dimensions, and technical terms.

Maintain bullet points or tabular formats where applicable.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Ensure specifications are understood and applicable in the {TARGET_LANG} context.

Instructions:

Keep all technical details exact.

Adapt units or measurement formats if required.

Avoid unnecessary descriptive or marketing language.

Output only the localized product specifications — no commentary or extra notes."\n\nText:\n{TEXT}`,
    'api-guides': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, developer-friendly, and technically accurate.

Act as a professional, bilingual technical translator with expertise in API documentation and {TARGET_LANG} programming terminology. Produce output that is precise, readable, and aligned with developer expectations.

Context Details:

Text Type: API Guide / API Reference Documentation

Style: Technical

Substyle: API Guides

Purpose: Help developers understand and implement the API effectively.

Tone: Concise, structured, and professional.

Language Style:

Preserve code snippets exactly as in the original.

Use {TARGET_LANG} explanations for parameters, functions, and usage notes.

Follow the official grammar and spelling rules of {TARGET_LANG}.

Localization Goal: Ensure the API documentation is easy to follow for {TARGET_LANG}-speaking developers without losing precision.

Instructions:

Keep all code examples unchanged.

Translate only the explanatory text and annotations.

Avoid altering technical terms that are standard."\n\nText:\n{TEXT}`,
  },

  legal: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving its legal meaning and adapting it to {TARGET_LANG} legal drafting norms.

Act as a professional bilingual legal translator with expertise in {TARGET_LANG} law. Produce output that is accurate, unambiguous, and compliant with {TARGET_LANG} legal terminology and structure.

Context Details:

Text Type: General Legal Document

Style: Legal

Substyle: General

Purpose: Communicate legal information clearly and formally without specifying document type.

Tone: Formal, precise, and authoritative.

Language Style:

Use formal legal vocabulary in {TARGET_LANG}.

Follow the official grammar, spelling, and legal drafting standards of {TARGET_LANG}.

Avoid colloquial or ambiguous terms.

Localization Goal: Ensure the translation has the same legal effect and clarity in {TARGET_LANG} as the source.

Instructions:

Preserve all legal meanings and obligations.

Avoid literal translation that could cause ambiguity in law.

Maintain numbering, clauses, and structure."\n\nText:\n{TEXT}`,
    contracts: `"Translate and localize the following text into {TARGET_LANG}, preserving its legal meaning while adapting it to {TARGET_LANG} legal language norms.

Act as a professional bilingual legal translator with expertise in {TARGET_LANG} contract law. Produce output that is accurate, unambiguous, and compliant with {TARGET_LANG} legal drafting conventions.

Context Details:

Text Type: Contract / Agreement

Style: Legal

Substyle: Contracts

Purpose: Ensure the translated contract has the same legal force and clarity as the original.

Tone: Formal, precise, and legally binding.

Language Style:

Use formal legal vocabulary in {TARGET_LANG}.

Follow official grammar, spelling, and legal formatting norms of {TARGET_LANG}.

Avoid colloquial language or vague expressions.

Localization Goal: Maintain legal intent, enforceability, and formatting conventions used in {TARGET_LANG} legal documents.

Instructions:

Translate with full legal accuracy.

Avoid literal translation if it causes ambiguity in legal interpretation.

Preserve numbering, clauses, and structure."\n\nText:\n{TEXT}`,
    'terms-conditions': `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while ensuring clarity, legality, and compliance with {TARGET_LANG} norms.

Act as a professional bilingual legal translator with expertise in {TARGET_LANG} consumer and digital regulations. Produce output that is clear, enforceable, and consistent with {TARGET_LANG} T&C drafting standards.

Context Details:

Text Type: Terms & Conditions (T&C)

Style: Legal

Substyle: Terms & Conditions

Purpose: Clearly outline rules, obligations, and legal disclaimers for users.

Tone: Formal, specific, neutral, and authoritative.

Language Style:

Use formal {TARGET_LANG} legal and business terminology.

Follow official grammar, spelling, and formatting practices of {TARGET_LANG}.

Avoid overly complex sentences that hinder understanding.

Localization Goal: Ensure the translated T&C are valid, comprehensible, and culturally adapted to {TARGET_LANG} laws and norms.

Instructions:

Preserve all legal rights, disclaimers, and limitations.

Avoid literal translation that creates legal loopholes.

Keep clause structure and numbering intact."\n\nText:\n{TEXT}`,
    'compliance-docs': `"Translate and localize the following text into {TARGET_LANG} preserving its legal and regulatory meaning while adapting it to {TARGET_LANG} compliance standards.

Act as a professional bilingual legal translator with expertise in {TARGET_LANG} regulatory compliance. Produce output that is accurate, compliant, and audit-ready.

Context Details:

Text Type: Compliance Documentation (e.g., SOPs, audit checklists, certifications)

Style: Legal

Substyle: Compliance Docs

Purpose: Ensure compliance documents are valid and understandable for {TARGET_LANG} regulatory bodies.

Tone: Formal, exact, objective, and precise.

Language Style:

Use standardized compliance and regulatory terminology in {TARGET_LANG}.

Follow official grammar, spelling, and industry document formatting in {TARGET_LANG}.

Avoid ambiguous or casual expressions.

Localization Goal: Adapt compliance references, formats, and terms for {TARGET_LANG} laws and industry standards.

Instructions:

Ensure accuracy for legal and regulatory review.

Avoid literal translation that misrepresents compliance requirements.

Preserve numbering, structure, and formatting."\n\nText:\n{TEXT}`,
    'privacy-policies': `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while ensuring compliance with {TARGET_LANG} privacy and data protection laws.

Act as a professional bilingual legal translator with expertise in {TARGET_LANG} data protection regulations. Produce output that is clear, accurate, and legally enforceable.

Context Details:

Text Type: Privacy Policy

Style: Legal

Substyle: Privacy Policies

Purpose: Inform users about their data rights and how their personal information is processed.

Tone: Formal, reassuring, clear, and transparent.

Language Style:

Use formal legal and privacy-related vocabulary in {TARGET_LANG}.

Follow official grammar, spelling, and comply with applicable data protection standards in {TARGET_LANG}.

Avoid vague or overly broad statements.

Localization Goal: Make the policy both legally accurate and easy for users to understand.

Instructions:

Translate with legal precision while keeping clarity for laypersons.

Avoid literal translation that causes regulatory conflicts.

Preserve structure, headings, and clause numbering."\n\nText:\n{TEXT}`,
    constitutional: `"Translate and localize the following text into {TARGET_LANG}, preserving its legal authority and formal tone while following {TARGET_LANG} constitutional language standards.

Act as a professional bilingual legal translator with expertise in {TARGET_LANG} constitutional law. Produce output that is formally precise, legally binding, and historically respectful.

Context Details:

Text Type: Constitutional Text / Law

Style: Legal

Substyle: Constitutional

Purpose: Maintain the original legal force and historical formality.

Tone: Extremely formal, authoritative, exact, and respectful.

Language Style:

Use official constitutional/legal {TARGET_LANG} vocabulary.

Follow official grammar, spelling, and legislative drafting conventions in {TARGET_LANG}.

Preserve historical and cultural accuracy.

Localization Goal: Keep exact legal meaning and respect the solemnity of constitutional language.

Instructions:

Translate with full legal fidelity and precision.

Avoid any paraphrasing that alters meaning.

Maintain exact numbering, clauses, and structure."\n\nText:\n{TEXT}`,
  },

  medical: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while ensuring it is clear, accurate, and suitable for a general medical context.

Act as a professional bilingual medical translator with expertise in {TARGET_LANG} health communication. Produce output that is accurate, professional, and easy to understand.

Context Details:

Text Type: General Medical Information

Style: Medical

Substyle: General

Purpose: Present medical information clearly without targeting a specific audience type.

Tone: Clear, informative, and neutral.

Language Style:

Use accurate medical terminology in {TARGET_LANG}.

Explain complex terms briefly if needed.

Follow official grammar and spelling standards.

Localization Goal: Ensure the information feels natural and professionally written in {TARGET_LANG}.

Instructions:

Maintain medical accuracy and clarity.

Avoid overly technical or overly simplified translations.

Use neutral, factual language."\n\nText:\n{TEXT}`,
    'patient-friendly-explanation': `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to be clear, simple, and reassuring for patients.

Act as a professional bilingual medical translator with expertise in {TARGET_LANG} health communication. Produce output that is accurate, easy to understand, and culturally sensitive.

Context Details:

Text Type: Patient Information / Medical Explanation

Style: Medical

Substyle: Patient-friendly Explanation

Purpose: Help patients understand medical information without confusion or fear.

Tone: Calm, clear, empathetic, and supportive.

Language Style:

Use everyday {TARGET_LANG} words instead of complex medical jargon (explain terms if needed).

Follow official grammar and spelling standards.

Maintain accuracy while simplifying concepts.

Localization Goal: Ensure the explanation feels natural, comforting, and culturally relevant to {TARGET_LANG} patients.

Instructions:

Maintain medical accuracy but explain in layman’s terms.

Avoid literal translation if it sounds overly technical.

Use short, clear sentences for readability."\n\nText:\n{TEXT}`,
    'research-abstracts': `"Translate and localize the following text into {TARGET_LANG}, preserving its scientific accuracy and academic tone.

Act as a professional bilingual medical translator with expertise in {TARGET_LANG} medical research publications. Produce output that is precise, formal, and scientifically credible.

Context Details:

Text Type: Medical Research Abstract

Style: Medical

Substyle: Research Abstracts

Purpose: Present research findings clearly to {TARGET_LANG} medical professionals and academics.

Tone: Formal, technical, objective, and concise.

Language Style:

Use standardized {TARGET_LANG} medical and scientific terminology.

Follow official grammar and spelling standards and {TARGET_LANG} academic writing norms.

Avoid unnecessary simplification — maintain professional rigor.

Localization Goal: Ensure the translated abstract is publication-ready for {TARGET_LANG} medical journals.

Instructions:

Maintain all data, terminology, and structure.

Avoid literal translation that distorts meaning.

Keep the tone strictly formal and scientific."\n\nText:\n{TEXT}`,
    'clinical-documentation': `"Translate and localize the following text into {TARGET_LANG}, preserving full medical accuracy and compliance with {TARGET_LANG} healthcare documentation standards.

Act as a professional bilingual medical translator with expertise in {TARGET_LANG} clinical and hospital records. Produce output that is accurate, clear, and compliant.

Context Details:

Text Type: Clinical Notes / Patient Records / Medical Reports

Style: Medical

Substyle: Clinical Documentation

Purpose: Ensure accuracy for patient care, diagnosis, and legal records in {TARGET_LANG}-speaking regions.

Tone: Formal, exact, clinical, and objective.

Language Style:

Use precise medical terminology in {TARGET_LANG}.

Follow official grammar and spelling standards and  {TARGET_LANG} medical norms.

Avoid unnecessary rewording — keep factual tone.

Localization Goal: Ensure translated documentation is medically valid and ready for official patient files in  {TARGET_LANG}.

Instructions:

Translate with 100% accuracy — no omissions or additions.

Keep original structure, headings, and numbering.

Avoid interpretive or explanatory translation."\n\nText:\n{TEXT}`,
    'health-campaigns': `"Translate and localize the following text into {TARGET_LANG}, preserving meaning while adapting tone to motivate and engage the {TARGET_LANG} public.

Act as a professional bilingual medical translator with expertise in public health communication. Produce output that is clear, persuasive, and culturally relevant.

Context Details:

Text Type: Public Health Campaign / Awareness Material

Style: Medical

Substyle: Health Campaigns

Purpose: Encourage healthy behaviors and inform the public about health risks or preventive measures.

Tone: Positive, motivating, clear, and empathetic.

Language Style:

Use friendly and accessible {TARGET_LANG} vocabulary.

Avoid excessive medical jargon — explain terms if needed.

Follow official grammar and spelling standards while keeping the tone engaging.

Localization Goal: Make health messages resonate emotionally and culturally with {TARGET_LANG} audiences.

Instructions:

Preserve core health message and facts.

Adapt examples, idioms, or scenarios for {TARGET_LANG} context.

Avoid literal translation that feels distant or cold."\n\nText:\n{TEXT}`,
  },

  journalistic: {
    general: `"Translate and localize the following text into {TARGET_LANG}, ensuring it reads like a natural {TARGET_LANG} news article.

Act as a professional bilingual news translator with expertise in {TARGET_LANG} journalism. Produce output that is factual, concise, and follows news writing norms.

Context Details:

Text Type: General News Article

Style: Journalistic

Substyle: General

Purpose: Report events clearly and accurately without bias.

Tone: Neutral, factual, and clear.

Language Style:

Use official grammar and spelling standards.

Maintain an inverted pyramid or logical news structure.

Include direct quotes and attributions where relevant.

Localization Goal: Ensure phrasing, references, and structure are natural for {TARGET_LANG}-speaking readers while maintaining accuracy.

Instructions:

Keep all facts accurate and verifiable.

Avoid literal translation that causes unnatural phrasing.

Preserve clarity and conciseness for easy reading."\n\nText:\n{TEXT}`,
    'news-reports': `"Translate and localize the following text into {TARGET_LANG}, preserving its meaning while adapting it to the cultural and linguistic norms of professional news reporting.

Act as a professional bilingual translator with expertise in {TARGET_LANG} news journalism and a deep understanding of cross-cultural communication. Produce output that is natural, fluent, and journalistic, suitable for public news consumption.

Context Details:

Style: Journalistic

Substyle: News Reports

Purpose: Inform readers about current events with clarity, accuracy, and engagement.

Tone: Neutral and factual, but flexible enough to adapt to the news context.

Language Style:

Use clear sentences with correct grammar and standard vocabulary.

May include direct quotes and attributed sources.

Maintain a neutral perspective, avoiding bias.

Follow official grammar and spelling standards.

Localization Goal: Adapt phrasing, references, and structure so it reads like a natural, professional {TARGET_LANG} news article while preserving the original meaning.

Instructions:

Accurately convey the original meaning and details.

Keep the tone factual and neutral, but allow natural news flow.

Use direct quotes and attributions as needed.

Avoid literal translation if it results in awkward phrasing.

Do not carry over source sentence structures that feel unnatural in {TARGET_LANG} news writing."\n\nText:\n{TEXT}`,
    'editorial-opinion': `"Translate and localize the following text into {TARGET_LANG}, preserving the argument’s clarity while adapting it to journalistic opinion writing norms.

Act as a professional bilingual journalist with expertise in {TARGET_LANG} editorial writing. Produce output that is persuasive, coherent, and aligned with opinion article conventions.

Context Details:

Text Type: Editorial / Opinion Piece

Style: Journalistic

Substyle: Editorial Opinion

Purpose: Present the writer’s opinion clearly while maintaining credibility and logical flow.

Tone: Persuasive, thoughtful, subjective, and authoritative.

Language Style:

Use formal or semi-formal {TARGET_LANG} as appropriate for editorials.

Maintain logical progression of ideas.

Follow official grammar and spelling standards.

Localization Goal: Ensure the piece feels like it was originally written for an {TARGET_LANG} editorial audience while preserving the author’s stance and reasoning.

Instructions:

Maintain the writer’s argument and supporting points.

dapt cultural references appropriately for the target audience.

Avoid literal translation that weakens persuasiveness."\n\nText:\n{TEXT}`,
    'feature-articles': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is engaging, descriptive, and adapted to feature writing norms.

Act as a professional bilingual journalist with expertise in {TARGET_LANG} long-form feature writing. Produce output that is informative, vivid, and audience-focused.

Context Details:

Text Type: Feature Article

Style: Journalistic

Substyle: Feature Articles

Purpose: Provide in-depth coverage of a topic in a compelling way.

Tone: Informative, engaging, and descriptive.

Language Style:

Rich vocabulary and varied sentence structure.

Incorporate descriptive details and human interest elements.

Follow official grammar and spelling standards.

Localization Goal: Ensure the feature reads naturally in {TARGET_LANG} while maintaining depth, style, and flow.

Instructions:

Preserve depth of information and descriptive details.

Adapt metaphors and cultural references where needed.

Avoid literal translation that disrupts narrative flow."\n\nText:\n{TEXT}`,
    'press-releases': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, factual, and aligned with {TARGET_LANG} PR communication standards.

Act as a professional bilingual media translator with expertise in {TARGET_LANG} press communications. Produce output that is professional, concise, and ready for publication.

Context Details:

Text Type: Press Release

Style: Journalistic

Substyle: Press Releases

Purpose: Announce news or updates to the media in a clear and concise manner.

Tone: Professional, factual, and direct.

Language Style:

Short, clear sentences.

Avoid excessive jargon unless industry-specific.

Follow official grammar and spelling standards, and use standard press release formatting.

Localization Goal: Ensure the release reads like a professional {TARGET_LANG} press statement while maintaining factual accuracy.

Instructions:

Keep all factual details intact.

Adapt date, time, and formatting to {TARGET_LANG} standards.

Avoid overly literal phrasing that sounds unnatural."\n\nText:\n{TEXT}`,
  },

  corporate: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving its professional tone and aligning it with corporate communication standards.

Act as a professional bilingual corporate translator with expertise in {TARGET_LANG} business communication. Produce output that is clear, professional, and brand-aligned.

Context Details:

Text Type: General Corporate Message

Style: Corporate

Substyle: General

Purpose: Deliver professional corporate messaging without targeting a specific document type.

Tone: Formal yet approachable and aligned with company voice..

Language Style:

Clear structure, concise sentences, professional vocabulary.

Follow official grammar and spelling standards, and company tone of voice guidelines.

Avoid unnecessary jargon.

Localization Goal: Ensure the corporate message feels authentic and relevant to {TARGET_LANG} business culture.

Instructions:

Keep communication clear and concise.

Adapt phrasing to sound natural in formal corporate {TARGET_LANG}.

Maintain brand voice and tone."\n\nText:\n{TEXT}`,
    'internal-communications': `"Translate and localize the following text into {TARGET_LANG}, preserving its clarity, professionalism, and alignment with {TARGET_LANG} corporate culture.

Act as a professional bilingual corporate translator with expertise in {TARGET_LANG} workplace communication. Produce output that is clear, respectful, and aligned with company values.

Context Details:

Text Type: Internal Communications (e.g., memos, employee updates, HR notices)

Style: Corporate

Substyle: Internal Communications

Purpose: Inform employees or teams in a professional yet approachable tone.

Tone: Formal yet warm, respectful, and engaging.

Language Style:

Use clear structure and concise sentences.

Follow official grammar and spelling standards.

Avoid unnecessary jargon unless industry-specific.

Localization Goal: Ensure the message feels natural for {TARGET_LANG} employees while keeping it aligned with company tone and values.

Instructions:

Maintain clarity and purpose of the original message.

Adapt references to suit {TARGET_LANG} corporate culture.

Avoid literal translations that sound stiff or unnatural."\n\nText:\n{TEXT}`,
    'investor-relations': `"Translate and localize the following text into {TARGET_LANG}, ensuring accuracy, professionalism, and compliance with financial communication norms.

Act as a professional bilingual financial and corporate translator with expertise in {TARGET_LANG} investor communication. Produce output that is precise, formal, and credible.

Context Details:

Text Type: Investor Relations Materials (e.g., shareholder letters, earnings summaries)

Style: Corporate

Substyle: Investor Relations

Purpose: Communicate corporate and financial information to shareholders and investors.

Tone: Formal, authoritative, and transparent.

Language Style:

Use formal financial and business vocabulary in {TARGET_LANG}.

Follow official grammar and spelling standards and standard financial reporting terms.

Avoid vague or ambiguous expressions.

Localization Goal: Ensure the content meets investor relations standards and remains precise in {TARGET_LANG}.

Instructions:

Keep all numerical and factual data intact.

Adapt terms to standard {TARGET_LANG} financial terminology.

Maintain professional tone throughout."\n\nText:\n{TEXT}`,
    'annual-reports': `"Translate and localize the following text into {TARGET_LANG}, ensuring professionalism, accuracy, and compliance with corporate reporting standards.

Act as a professional bilingual corporate and financial translator with expertise in {TARGET_LANG} annual reports. Produce output that is clear, formal, and ready for publication.

Context Details:

Text Type: Annual Report Content

Style: Corporate

Substyle: Annual Reports

Purpose: Present company performance, achievements, and plans in a professional format.

Tone: Formal, confident, and factual.

Language Style:

Use correct corporate and financial terms in {TARGET_LANG}.

Follow official grammar and spelling standards and {TARGET_LANG} corporate reporting conventions.

Maintain clear structure with headings if present.

Localization Goal: Ensure the report reads like it was written in {TARGET_LANG} while preserving all details.

Instructions:

Keep all data, dates, and figures exactly as in the original.

Adapt terms to standard {TARGET_LANG} corporate and accounting language.

Maintain professional tone without unnecessary embellishment."\n\nText:\n{TEXT}`,
    'professional-presentations': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, professional, and engaging for a corporate audience.

Act as a professional bilingual corporate translator with expertise in {TARGET_LANG} business presentations. Produce output that is impactful, concise, and audience-appropriate.

Context Details:

Text Type: Professional Presentation (slides, scripts, corporate pitches)

Style: Corporate

Substyle: Professional Presentations

Purpose: Deliver key points in a persuasive yet professional manner.

Tone: Formal, confident, and engaging.

Language Style:

Use concise, impactful sentences.

Follow official grammar and spelling standards and {TARGET_LANG} business communication norms.

Use bullet-friendly phrasing where applicable.

Localization Goal: Ensure the presentation content resonates with {TARGET_LANG} corporate audiences while maintaining professional impact.

Instructions:

Preserve the clarity and flow of the original presentation.

Adapt terms to standard {TARGET_LANG} business terminology.

Avoid overly long or complex sentences."\n\nText:\n{TEXT}`,
  },

  entertainment: {
    general: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is engaging, relatable, and audience-friendly.

Act as a professional bilingual entertainment translator with expertise in {TARGET_LANG} pop culture and media. Produce output that is fun, dynamic, and culturally engaging.

Context Details:

Text Type: General Entertainment Content

Style: Entertainment

Substyle: General

Purpose: Entertain and engage the audience without focusing on a specific entertainment category.

Tone: Fun, energetic, and inviting.

Language Style:

Conversational flow, lively vocabulary.

Follow official grammar and spelling standards while allowing creative freedom for entertainment value.

Adapt idioms and cultural references for relevance.

Localization Goal: Ensure the content feels like it was originally written for an {TARGET_LANG} entertainment audience.

Instructions:

Keep the tone lively and engaging.

Adapt references to fit {TARGET_LANG} entertainment culture.

Avoid overly literal translation that loses entertainment value."\n\nText:\n{TEXT}`,
    subtitling: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, concise, and engaging as subtitles.

Act as a professional bilingual entertainment subtitle translator with expertise in {TARGET_LANG} audiovisual translation. Produce output that is accurate, natural, and timed for easy reading.

Context Details:

Text Type: Entertainment Subtitles

Style: Entertainment

Substyle: Subtitling

Purpose: Make the content fun, clear, and accessible for {TARGET_LANG} viewers.

Tone: Matches the original scene’s emotional tone (funny, dramatic, suspenseful, etc.), concise, and natural.

Language Style:

Short, concise lines that fit reading speed guidelines.

Follow official grammar and spelling standards while keeping a natural spoken flow.

Adapt cultural references for relevance.

Localization Goal: Ensure subtitles feel natural to {TARGET_LANG} viewers while keeping the entertainment value intact.

Instructions:

Keep lines short and easy to read on screen.

Adapt idioms, jokes, or slang to equivalent {TARGET_LANG} expressions.

Avoid literal translation that breaks the natural entertainment tone."\n\nText:\n{TEXT}`,
    screenwriting: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is ready for production and culturally engaging.

Act as a professional bilingual screenwriter-translator with expertise in {TARGET_LANG} film and TV scripts. Produce output that is natural, dramatic, and audience-appropriate.

Context Details:

Text Type: Screenplay (Film/TV)

Style: Entertainment

Substyle: Screenwriting

Purpose: Adapt scripts so they work naturally for {TARGET_LANG} actors and audiences.

Tone: Matches original scene — could be dramatic, comedic, romantic, or suspenseful.

Language Style:

Use spoken-friendly {TARGET_LANG} dialogue.

Follow official grammar and spelling standards while allowing creative liberties for performance flow.

Adapt cultural references to equivalents relevant for the audience.

Localization Goal: Make the script feel as if it was originally written in {TARGET_LANG} for local audiences.

Instructions:

Maintain character voice and personality.

Adapt humor, idioms, or references for local understanding.

Avoid literal translation that disrupts performance flow."\n\nText:\n{TEXT}`,
    'script-adaptation': `"Translate and localize the following text into {TARGET_LANG}, ensuring it fits local culture, humor, and audience preferences.

Act as a professional bilingual script adapter with expertise in {TARGET_LANG} entertainment media. Produce output that is engaging, natural, and culturally adapted.

Context Details:

Text Type: Script for adaptation (Film, TV, Web series, Theatre)

Style: Entertainment

Substyle: Script Adaptation

Purpose: Retain story flow while making it relatable to {TARGET_LANG} audiences.

Tone: Matches the original scene’s emotional tone and pacing.

Language Style:

Natural, audience-friendly {TARGET_LANG} phrasing.

Follow official grammar and spelling standards while allowing creative flow.

Replace untranslatable references with culturally relevant equivalents.

Localization Goal: Ensure the adapted script feels authentic to {TARGET_LANG} entertainment culture.

Instructions:

Maintain plot, tone, and character integrity.

Replace idioms or cultural jokes with {TARGET_LANG} equivalents.

Keep dialogue flow smooth for performance delivery."\n\nText:\n{TEXT}`,
    'character-dialogue': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is true to the character’s personality and the scene’s mood.

Act as a professional bilingual entertainment dialogue translator with expertise in {TARGET_LANG} spoken character writing. Produce output that is natural, in-character, and culturally engaging.

Context Details:

Text Type: Character Dialogue

Style: Entertainment

Substyle: Character Dialogue

Purpose: Keep each character’s voice authentic and relatable for {TARGET_LANG} audiences.

Tone: Matches the original personality (serious, playful, sarcastic, etc.).

Language Style:

Spoken-friendly {TARGET_LANG}, adjusted for personality and age group.

Follow official grammar and spelling standards while maintaining natural, believable speech.

Adapt cultural cues for {TARGET_LANG} context.

Localization Goal: Ensure dialogue sounds like it was originally written for {TARGET_LANG} characters.

Instructions:

Keep the character’s voice and style intact.

Adapt slang, humor, or tone to {TARGET_LANG} cultural context.

Avoid unnatural literal translations."\n\nText:\n{TEXT}`,
  },

  educational: {
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving its instructional clarity and adapting it for {TARGET_LANG} learners.

Act as a professional bilingual educational translator with expertise in {TARGET_LANG} learning materials. Produce output that is clear, supportive, and easy to follow.

Context Details:

Text Type: General Educational Content

Style: Education

Substyle: General

Purpose: Provide accessible and accurate learning content for a wide audience.

Tone: Supportive, clear, and motivating.

Language Style:

Use plain {TARGET_LANG} for accessibility.

Follow logical, step-by-step explanations.

Follow official grammar and spelling standards.

Localization Goal: Make learning content intuitive and relatable for {TARGET_LANG} readers.

Instructions:

Maintain accuracy of facts and processes.

Avoid overly technical or academic jargon unless necessary.

Keep sentences short and clear for easy comprehension."\n\nText:\n{TEXT}`,
    'e-learning': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, engaging, and suitable for digital learning platforms.

Act as a professional bilingual educational translator with expertise in {TARGET_LANG} online learning content. Produce output that is easy to understand, motivating, and learner-friendly.

Context Details:

Text Type: E-learning Material (videos, interactive lessons, modules)

Style: Education

Substyle: E-learning

Purpose: Deliver knowledge effectively in a digital format for {TARGET_LANG} learners.

Tone: Encouraging, clear, and interactive.

Language Style:

Use plain {TARGET_LANG} for accessibility.

Follow logical, easy-to-digest sentence structure.

Follow official grammar and spelling standards.

Localization Goal: Ensure the e-learning content feels natural, motivating, and accessible for {TARGET_LANG} learners.

Instructions:

Maintain clarity while avoiding overly technical or academic jargon.

Adapt examples or cultural references for {TARGET_LANG} learners.

Keep a tone that promotes active learning and engagement."\n\nText:\n{TEXT}`,
    'step-by-step-guides': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, sequential, and easy to follow.

Act as a professional bilingual instructional translator with expertise in {TARGET_LANG} user and learner guides. Produce output that is accurate, concise, and user-friendly.

Context Details:

Text Type: Instructional Step-by-step Guide

Style: Education

Substyle: Step-by-step Guides

Purpose: Provide clear, actionable instructions for {TARGET_LANG} users or learners.

Tone: Clear, supportive, sequential, and direct.

Language Style:

Sequential numbering or bullet format where relevant.

Use plain, simple {TARGET_LANG} for easy comprehension.

Follow official grammar and spelling standards.

Localization Goal: Ensure the guide feels natural and logical to {TARGET_LANG} readers while maintaining accuracy.

Instructions:

Preserve the logical order of steps.

Avoid unnecessary complexity in phrasing.

Adapt terms to standard {TARGET_LANG} where applicable."\n\nText:\n{TEXT}`,
    'academic-tutorials': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, accurate, and aligned with {TARGET_LANG} academic conventions.

Act as a professional bilingual academic translator with expertise in {TARGET_LANG} instructional and academic materials. Produce output that is structured, precise, and easy to follow.

Context Details:

Text Type: Academic Tutorial (lesson walkthrough, subject-specific instruction)

Style: Education

Substyle: Academic Tutorials

Purpose: Teach academic concepts in a way that {TARGET_LANG} learners can understand.

Tone: Formal yet approachable, educational, explanatory, and clear.

Language Style:

Use correct academic terminology in {TARGET_LANG}.

Maintain structured, logical explanations.

Follow official grammar and spelling standards.

Localization Goal: Ensure the tutorial reads naturally for {TARGET_LANG} students while preserving academic accuracy.

Instructions:

Keep concepts clear and logically structured.

Avoid literal translations that disrupt academic flow.

Adapt examples or cultural references where needed."\n\nText:\n{TEXT}`,
    'test-preparation': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, accurate, and motivating for learners.

Act as a professional bilingual educational translator with expertise in {TARGET_LANG} exam preparation materials. Produce output that is student-focused, encouraging, and precise.

Context Details:

Text Type: Test Preparation Content (practice questions, study tips, exam strategies)

Style: Education

Substyle: Test Preparation

Purpose: Help learners prepare effectively for tests or exams.

Tone: Supportive, structured, focused clear, and motivational.

Language Style:

Use straightforward, easy-to-understand {TARGET_LANG}.

Follow official grammar and spelling standards.

Maintain a balance between clarity and engagement.

Localization Goal: Ensure the preparation material feels relevant and encouraging for {TARGET_LANG} learners.

Instructions:

Keep instructions and examples clear and direct.

Adapt terminology to {TARGET_LANG} education standards.

Avoid overly complex phrasing that may confuse learners."\n\nText:\n{TEXT}`,
  },
};

/** ---------------- Temperature policy ----------------
 * Conservative by default; raise slightly for creative/marketing,
 * lower for legal/technical/JSON-sensitive tasks.
 */

// Back-compat alias map for deprecated substyles → new taxonomy
const SUBSTYLE_ALIASES = {
  'formal:business': ['corporate','general'],
  'formal:financial': ['corporate','investor-relations'],
  'formal:dialogue': ['dubbing','dialogue'],

  'casual:dialogue': ['entertainment','character-dialogue'],
  'casual:social-media': ['marketing','social-media'],

  'marketing:descriptive': ['marketing','product-descriptions'],
  'marketing:pitching': ['marketing','persuasive'],
  'marketing:social-media-marketing': ['marketing','social-media'],

  'dubbing:narrative': ['dubbing','narration'],
  'dubbing:historical': ['dubbing','narration'],
  'dubbing:kids': ['dubbing','narration'],

  'creative:storytelling': ['creative','narrative-prose'],
};

// Hydrate new prompt keys so new names resolve to real templates
PROMPTS.marketing['product-descriptions'] = PROMPTS.marketing['descriptive'];
PROMPTS.marketing['social-media'] = PROMPTS.marketing['social-media-marketing'] || (PROMPTS.casual && PROMPTS.casual['social-media']);
PROMPTS.dubbing['narration'] = PROMPTS.dubbing['narrative'];
PROMPTS.creative['narrative-prose'] = PROMPTS.creative['storytelling'];

const TEMP_BASE = 0.30;
const TEMP_BY_MODE = {
  formal: 0.25,
  casual: 0.35,
  marketing: 0.45,
  // a little tighter for spoken lines to reduce drift
  dubbing: 0.22,
  creative: 0.55,
  technical: 0.20,
  legal: 0.15,
  medical: 0.20,
  journalistic: 0.25,
  corporate: 0.25,
  entertainment: 0.35,
  educational: 0.30,
};

const TEMP_BY_SUB = {
  // precision-oriented
  dialogue: -0.07,
  subtitling: -0.07,
  'software-documentation': -0.05,
  'engineering-manuals': -0.05,
  'product-specs': -0.05,
  'api-guides': -0.05,
  contracts: -0.10,
  'terms-conditions': -0.10,
  'compliance-docs': -0.10,
  'privacy-policies': -0.10,
  'clinical-documentation': -0.05,
  'research-abstracts': -0.05,

  // style/voice
  'brand-storytelling': +0.05,
  comedy: +0.05,
  'street-talk': +0.05,
  'screenwriting': +0.05,
  'script-adaptation': +0.05,
  'slogan-tagline-writing': +0.10,
  'poetic-tone': +0.10,
};

/** Guard to discourage dashes/bullets in model output */
const STYLE_GUARD = `
Formatting constraints:
- Do NOT use em dashes (—) or en dashes (–) as punctuation.
- Do NOT use " - " as a separator and do NOT use bullet lists.
- Use commas or periods instead.
- Keep hyphens only inside words where linguistically required (e.g., co-founder, anak-anak).
- Return plain paragraphs only.
`;

/** Global subtitle/dubbing overrides (applies on top of the per-mode templates) */
const SUBTITLE_OVERRIDES = `
GLOBAL SUBTITLE/DUBBING RULES:
- CONTEXT PRESERVATION: Maintain the emotional impact and implied meaning of each line. "Sangue..." with ellipsis suggests suspense/concern, not just literal "Blood."
- PUNCTUATION PRESERVATION: Keep exactly the same punctuation from source. If source ends with "?", target must end with "?". If source ends with "...", preserve the ellipsis and tone. CRITICAL: "Senão..." must become "Otherwise..." NOT "Otherwise." - preserve ellipsis for emotional context.
- CONTINUATION vs NEW SENTENCE:
  Treat a cue as a continuation ONLY if the previous cue does not end with terminal punctuation (. ? ! … or their local equivalents). Ignore whether the current cue starts lowercase.
  If the previous cue ends with terminal punctuation, start a new sentence and capitalize normally in the target language.
- 1:1 SEGMENT MAPPING IS MANDATORY:
  You MUST return exactly one target line for each source line. Do NOT merge short cues into longer ones. Do NOT split a source cue into multiple target cues.
  If a word naturally belongs to the next/previous cue (e.g., an adverb like "secretly"), KEEP IT in the same cue index as the source provided. Never move content across cue boundaries.
  Example: Italian cue 36 "di nascosto" MUST be translated as cue 36 "secretly" (or its equivalent), not appended to cue 35.
- KINSHIP vs HONORIFIC (applies to ALL languages):
  When a word can be a family role OR a polite title (e.g., Indonesian "Ibu/Bu", "Bapak/Pak"; Japanese お母さん/お父さん vs 奥様/旦那様, etc.), DEFAULT to the family role when the cue is a vocative without a name (e.g., "Bu," "Pak!").
  Only use the honorific (e.g., "Ma'am", "Sir") when context clearly indicates a non-family/formal interaction (service roles, strangers, titles with names like "Bu Rina", occupational titles like "Ibu Guru").
  Once resolved within a scene, keep the same choice consistently across adjacent cues unless context obviously changes.
- NUMERALS:
  If the source uses Arabic digits for a number, keep digits in the target (do not spell out "Fourteen" for "14"), except where the target language mandates otherwise in formal legal documents.
- ON SCREEN LENGTH:
  Keep one line per input cue, 1:1. Preserve sentence-ending punctuation from the source cue. Do not add a period if the source cue has none.
- EMOTIONAL TONE: Preserve the emotional weight - suspense ("..."), questions ("?"), urgency ("!").
- DO NOT invent interjections, do not change kinship gender, and do not add or remove content.
- DO NOT modify punctuation from source. DO NOT add or remove question marks, periods, or ellipses.
`;

/* ---------------- Helpers: local, non-redeclaring ---------------- */

// Local versions so we never depend on globals defined elsewhere
const safeSlugify = (s = '') =>
  String(s).toLowerCase().replace(/[^\w]+/g, '-').replace(/(^-|-$)/g, '');

const safeRenderTemplate = (tmpl, { TARGET_LANG, TEXT }) =>
  String(tmpl || '')
    .replace(/\{TARGET_LANG\}/g, TARGET_LANG || 'the same language as the input')
    .replace(/\{TEXT\}/g, TEXT || '');

const clamp = (v, lo = 0.1, hi = 0.7) => Math.max(lo, Math.min(hi, v));
function pickTemperature(mode = '', subStyle = '', rephrase = false) {
  const m = String(mode || '').toLowerCase();
  const s = String(subStyle || '').toLowerCase();
  let t = TEMP_BY_MODE[m] ?? TEMP_BASE;
  t += TEMP_BY_SUB[s] ?? 0;
  if (rephrase) t -= 0.05;
  return Number(clamp(t, 0.1, 0.7).toFixed(2));
}

/** Extract between <result> tags */
function extractResultTagged(raw = '') {
  const m = String(raw).match(/<result>([\s\S]*?)<\/result>/i);
  const body = (m ? m[1] : raw) || '';
  return body.replace(/<\/?result>/gi, '').trim();
}

/** Capitalize first letter after a terminal from previous line */
function fixCapsAfterTerminals2(text = '') {
  const lines = String(text).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const prev = (lines[i - 1] || '').trim();
    const cur = lines[i] || '';
    const prevEnds = /[.!?…？！。]["'”’)\]]*\s*$/.test(prev);
    if (!prevEnds) continue;
    lines[i] = cur.replace(
      /^(\s*["'“‘(\[]*)(\p{Ll})/u,
      (_, pfx, ch) => pfx + (ch.toLocaleUpperCase ? ch.toLocaleUpperCase() : ch.toUpperCase())
    );
  }
  return lines.join('\n');
}

/** Keep digits as digits (English 0–99 fallback when model spells words) */
const EN_UNITS = [
  'zero','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'
];
const EN_TENS = { 20:'twenty', 30:'thirty', 40:'forty', 50:'fifty', 60:'sixty', 70:'seventy', 80:'eighty', 90:'ninety' };
function enSpell(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0 || n > 99) return null;
  if (n < 20) return EN_UNITS[n];
  const tens = Math.floor(n/10)*10, ones = n%10;
  return EN_TENS[tens] + (ones ? '-' + EN_UNITS[ones] : '');
}
function enforceNumericPreservation(srcText = '', tgtText = '', targetLanguage = '') {
  const looksEnglish = String(targetLanguage || '').toLowerCase().startsWith('en');
  const srcLines = String(srcText).split(/\r?\n/);
  const tgtLines = String(tgtText).split(/\r?\n/);
  const L = Math.max(srcLines.length, tgtLines.length);

  for (let i = 0; i < L; i++) {
    const src = srcLines[i] || '';
    let tgt = tgtLines[i] || '';
    const srcNums = (src.match(/\d+(?:[.,]\d+)?/g) || []).map(s => s.replace(/[^\d]/g, '')).filter(Boolean);
    const tgtHasDigits = /\d/.test(tgt);
    if (!srcNums.length || tgtHasDigits) { tgtLines[i] = tgt; continue; }

    if (looksEnglish) {
      for (const num of srcNums) {
        const n = parseInt(num, 10);
        const spelled = enSpell(n);
        if (!spelled) continue;
        const pattern = spelled.replace('-', '[-\\s]?'); // allow hyphen or space
        const re = new RegExp(`\\b${pattern}\\b`, 'gi');
        if (re.test(tgt)) tgt = tgt.replace(re, String(n));
      }
    }
    tgtLines[i] = tgt;
  }
  return tgtLines.join('\n');
}

/** Prevent statement → inverted-question drift in English while preserving legitimate questions */
function stabilizeMoodEN(srcText = '', tgtText = '') {
  const srcLines = String(srcText).split(/\r?\n/);
  const tgtLines = String(tgtText).split(/\r?\n/);
  const L = Math.max(srcLines.length, tgtLines.length);

  const invReps = [
    [/^\s*(Have|Has)\s+you\b/i, 'You have'],
    [/^\s*(Had)\s+you\b/i, 'You had'],
    [/^\s*(Are)\s+you\b/i, 'You are'],
    [/^\s*(Were)\s+you\b/i, 'You were'],
    [/^\s*(Do|Does)\s+you\b/i, 'You do'],
    [/^\s*(Did)\s+you\b/i, 'You did'],
    [/^\s*(Will)\s+you\b/i, 'You will'],
    [/^\s*(Would)\s+you\b/i, 'You would'],
    [/^\s*(Should)\s+you\b/i, 'You should'],
    [/^\s*(Could)\s+you\b/i, 'You could'],
    [/^\s*(Can)\s+you\b/i, 'You can'],
    [/^\s*(Must)\s+you\b/i, 'You must'],
  ];

  for (let i = 0; i < L; i++) {
    const src = (srcLines[i] || '').trim();
    let tgt = (tgtLines[i] || '').trim();
    
    // Check if source is actually a question
    const srcIsQuestion = /[?？]\s*$/.test(src);
    const srcHasQuestionWords = /\b(who|what|when|where|why|how|which|whom|whose|como|quem|que|quando|onde|por que|qual)\b/i.test(src);
    const tgtIsQuestion = /[?？]\s*$/.test(tgt);
    const tgtHasQuestionWords = /\b(who|what|when|where|why|how|which|whom|whose)\b/i.test(tgt);
    
    // If source is clearly a question, preserve the target as-is (don't modify)
    if (srcIsQuestion || srcHasQuestionWords) { 
      // Keep target exactly as GPT-4o provided it - don't add or remove punctuation
      tgtLines[i] = tgt; 
      continue; 
    }

    // Only fix obvious inverted questions, preserve all others
    if (tgtIsQuestion && !srcIsQuestion && !srcHasQuestionWords) {
      // Check if this is clearly an inverted question pattern
      let isInvertedQuestion = false;
      for (const [re, rep] of invReps) {
        if (re.test(tgt)) { 
          tgt = tgt.replace(re, rep);
          tgt = tgt.replace(/[?？]\s*$/, '.');
          isInvertedQuestion = true;
          break; 
        }
      }
      
      // Only remove question marks from obvious inverted questions
      // For anything else, preserve the question mark as it might be legitimate
    }
    
    tgtLines[i] = tgt;
  }
  return tgtLines.join('\n');
}

/** Final sanitize with source awareness */
function sanitizeWithSource(txt = '', srcText = '', targetLanguage = '') {
  if (!txt) return txt;
  
  // Count important punctuation in source to preserve in target
  const srcQuestionMarks = (srcText.match(/\?/g) || []).length;
  const srcExclamations = (srcText.match(/!/g) || []).length;
  const srcEllipsis = (srcText.match(/\.\.\./g) || []).length;
  
  let out = txt
    .replace(/(^|\n)\s*[-•◦‣▪︎]\s+/g, '$1')
    .replace(/\s[–—-]+\s/g, ', ')
    .replace(/(\p{L})[–—](\p{L})/gu, '$1, $2')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ', ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/<\/?result>/gi, '')
    .trim();

  // Preserve important punctuation if it was removed
  const outQuestionMarks = (out.match(/\?/g) || []).length;
  const outExclamations = (out.match(/!/g) || []).length;
  const outEllipsis = (out.match(/\.\.\./g) || []).length;
  
  // Preserve ellipsis for emotional context (suspense, hesitation, etc.)
  if (srcEllipsis > 0 && outEllipsis < srcEllipsis) {
    console.log(`Preserving ellipsis: source had ${srcEllipsis}, output has ${outEllipsis}`);
    
    const lines = out.split('\n');
    const srcLines = srcText.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const srcLine = (srcLines[i] || '').trim();
      
      // If source line had ellipsis but target doesn't, restore it
      if (/\.\.\.\s*$/.test(srcLine) && !/\.\.\.\s*$/.test(line)) {
        // Replace ending period with ellipsis to preserve emotional tone
        lines[i] = line.replace(/\.\s*$/, '...');
        console.log(`Restored ellipsis: "${srcLine}" → "${lines[i]}"`);
      }
    }
    out = lines.join('\n');
  }
  
  // Similar for exclamations
  if (srcExclamations > 0 && outExclamations === 0) {
    // Look for excited/emphatic content and add exclamation
    if (/\b(wow|amazing|great|excellent|wonderful)\b/i.test(out)) {
      out = out.replace(/([.])(\s*$)/g, '!$2');
    }
  }

  out = fixCapsAfterTerminals2(out);
  out = enforceNumericPreservation(srcText, out, targetLanguage);
  if (String(targetLanguage || '').toLowerCase().startsWith('en')) {
    out = stabilizeMoodEN(srcText, out);
  }
  
  // Final cleanup: remove any double punctuation and fix common issues
  out = out.replace(/\?\?+/g, '?');
  out = out.replace(/!!+/g, '!');
  out = out.replace(/\.\.\.\.+/g, '...'); // Preserve ... but not ....
  out = out.replace(/([^.])\.\.$/, '$1...'); // Fix broken ellipsis
  
  return out;
}

/** Build prompt (uses local helpers so no missing refs) */

/** Render/limit injections block safely */
function renderInjections(injections) {
  if (!injections) return '';
  let s = typeof injections === 'string' ? injections : JSON.stringify(injections, null, 2);
  s = String(s).trim();
  if (!s) return '';
  const cap = Number(process.env.INJECTION_CAP || 12000);
  if (s.length > cap) s = s.slice(0, cap);
  return `
[BRAND/GLOSSARY/PHRASEBOOK INJECTIONS]
${s}
`.trim();
}

// (Removed compact guideline maps – legacy templates only)

// (Removed compact template builder – reverting to legacy templates only)

function buildPrompt({ text, mode, subStyle, targetLanguage, rephrase, injections }) {
  const modeKey = safeSlugify(mode);
  const subKey = subStyle ? safeSlugify(subStyle) : 'general';

  const byMode = PROMPTS[modeKey] || {};
  const tmpl =
    byMode[subKey] ||
    byMode['general'] ||
    `Translate the text into {TARGET_LANG}.\n\nText:\n{TEXT}`;

  const needsSubtitleRules =
    modeKey === 'dubbing' || subKey === 'subtitling' || subKey === 'dialogue';

    // ✅ Create separate QA blocks for translation vs rephrase
  const TRANSLATION_QA_BLOCK = `
QUALITY CHECK BEFORE RETURN:
- Context preservation: Maintain the emotional tone, context, and implied meaning of the original.
- Cultural adaptation: Adapt for {TARGET_LANG} speakers while preserving the original intent.
- Punctuation preservation: Keep the same punctuation type from source (? stays ?, . stays ., ! stays !, ... stays ...).
- Terminology consistency: keep domain terms consistent within the output.
- Locale formats: use {TARGET_LANG} date/time/number/currency formatting; convert units only if appropriate.
- Paragraph integrity: no lists or dashes; return plain paragraphs only.
- Output must be returned ONLY between <result> and </result>.
`;

  const REPHRASE_QA_BLOCK = `
QUALITY CHECK BEFORE RETURN:
- Language preservation: Keep the EXACT same language as the input - DO NOT translate to any other language.
- Context preservation: Maintain the emotional tone, context, and implied meaning of the original.
- Style adaptation: Apply the requested style and substyle while keeping the same language.
- Punctuation preservation: Keep the same punctuation type from source (? stays ?, . stays ., ! stays !, ... stays ...).
- Terminology consistency: keep domain terms consistent within the output.
- Paragraph integrity: no lists or dashes; return plain paragraphs only.
- Output must be returned ONLY between <result> and </result>.
`;

  const injBlock = renderInjections(injections);

  if (rephrase || !targetLanguage) {
    // ✅ For rephrase: Use style template but replace translation instructions
    const rephraseTemplate = tmpl
      .replace(/Translate.*?into\s+\{TARGET_LANG\}/gi, 'Rephrase the following text')
      .replace(/\{TARGET_LANG\}/g, 'the same language as the input')
      .replace(/translation/gi, 'rephrasing')
      .replace(/translate/gi, 'rephrase');

    const renderedTmpl = safeRenderTemplate(rephraseTemplate, {
      TARGET_LANG: 'the same language as the input',
      TEXT: text,
    });

    const renderedQA = safeRenderTemplate(REPHRASE_QA_BLOCK, {
      TARGET_LANG: 'the same language as the input',
      TEXT: text,
    });

    const commonTail = `
${STYLE_GUARD}
${needsSubtitleRules ? SUBTITLE_OVERRIDES : ''}

${injBlock ? injBlock + '\n' : ''}

${renderedQA}

${renderedTmpl}

<result>
`;

    return `
You are an expert writing and style assistant with advanced skills in style adaptation, tone consistency, and clarity improvement.
Always strictly follow the provided style, substyle, tone, and language style guidelines.

CRITICAL: DO NOT translate to any other language. Keep the EXACT same language as the input text. Only rephrase to match the requested style and sub-style while maintaining the original language. Improve clarity and style without changing the language.

Return ONLY the final output strictly between <result> and </result>. No explanations.
${commonTail}`.trim();
  }

  // ✅ For translation: Use original logic
  const renderedTmpl = safeRenderTemplate(tmpl, {
    TARGET_LANG: targetLanguage || 'the same language as the input',
    TEXT: text,
  });

  const renderedQA = safeRenderTemplate(TRANSLATION_QA_BLOCK, {
    TARGET_LANG: targetLanguage || 'the same language as the input',
    TEXT: text,
  });

  const commonTail = `
${STYLE_GUARD}
${needsSubtitleRules ? SUBTITLE_OVERRIDES : ''}

${injBlock ? injBlock + '\n' : ''}

${renderedQA}

${renderedTmpl}

<result>
`;

  return `
You are an expert localization and translation assistant with advanced skills in cultural adaptation, style consistency, and terminology accuracy.
Always strictly follow the provided style, substyle, tone, and language style guidelines.

Return ONLY the final output strictly between <result> and </result>. No extra words.
${commonTail}`.trim();
}

/** ------------------------- Authentication Routes ------------------------- */
const bcrypt = require('bcryptjs');
const { generateToken, hashPassword } = require('./auth');

// User registration
app.post('/auth/register', rateLimiters.auth, async (req, res) => {
  try {
    const { email, password, name, tier } = req.body || {};

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Create user
    const allowedTiers = new Set(['free','pro','team']);
    const userTier = allowedTiers.has(String(tier||'').toLowerCase()) ? String(tier).toLowerCase() : 'free';
    const passwordHash = await hashPassword(password);
    const result = await db.run(`
      INSERT INTO users (email, password_hash, name, tier)
      VALUES (?, ?, ?, ?)
    `, [email, passwordHash, name, userTier]);

    const user = await db.get('SELECT id, email, name, tier FROM users WHERE id = ?', [result.id]);
    const token = generateToken(user);

    res.status(201).json({
      message: 'User created successfully',
      user,
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Admin endpoint to register user (development only)
app.post('/admin/register', async (req, res) => {
  try {
    // Only allow in development or with special admin key
    const isDev = process.env.NODE_ENV !== 'production';
    const hasAdminKey = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
    
    if (!isDev && !hasAdminKey) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, password, name, tier } = req.body || {};
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user already exists
    const existingUser = await db.get('SELECT id, email, tier FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.json({
        message: 'User already exists',
        user: existingUser,
        action: 'found_existing'
      });
    }

    // Create user with specified tier
    const allowedTiers = new Set(['free','pro','team']);
    const userTier = allowedTiers.has(String(tier||'').toLowerCase()) ? String(tier).toLowerCase() : 'team';
    const passwordHash = await hashPassword(password);
    
    const result = await db.run(`
      INSERT INTO users (email, password_hash, name, tier)
      VALUES (?, ?, ?, ?)
    `, [email, passwordHash, name, userTier]);

    const newUser = await db.get('SELECT id, email, name, tier, created_at FROM users WHERE id = ?', [result.id]);
    
    console.log(`✅ Admin: Created user ${email} with ${userTier} tier`);

    res.json({
      message: 'User created successfully',
      user: newUser,
      action: 'created'
    });

  } catch (error) {
    console.error('Admin register error:', error);
    res.status(500).json({ error: 'User registration failed' });
  }
});

// Debug endpoint to list all users (development only)
app.get('/admin/users', async (req, res) => {
  try {
    // Only allow in development or with special admin key
    const isDev = process.env.NODE_ENV !== 'production';
    const hasAdminKey = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
    
    if (!isDev && !hasAdminKey) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const users = await db.all('SELECT id, email, name, tier, created_at FROM users ORDER BY created_at DESC');
    
    res.json({
      message: 'Users retrieved successfully',
      users,
      count: users.length
    });

  } catch (error) {
    console.error('Admin users list error:', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// Admin endpoint to update user tier (development only)
app.post('/admin/update-tier', async (req, res) => {
  try {
    // Only allow in development or with special admin key
    const isDev = process.env.NODE_ENV !== 'production';
    const hasAdminKey = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
    
    if (!isDev && !hasAdminKey) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, tier } = req.body || {};
    
    if (!email || !tier) {
      return res.status(400).json({ error: 'Email and tier are required' });
    }

    const allowedTiers = ['free', 'pro', 'team'];
    if (!allowedTiers.includes(tier.toLowerCase())) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${allowedTiers.join(', ')}` });
    }

    // Check if user exists
    const user = await db.get('SELECT id, email, name, tier FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update user tier
    await db.run('UPDATE users SET tier = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?', 
      [tier.toLowerCase(), email]);

    // Get updated user
    const updatedUser = await db.get('SELECT id, email, name, tier FROM users WHERE email = ?', [email]);

    console.log(`✅ Admin: Updated user ${email} tier from "${user.tier}" to "${updatedUser.tier}"`);

    res.json({
      message: 'User tier updated successfully',
      user: updatedUser,
      previousTier: user.tier
    });

  } catch (error) {
    console.error('Admin tier update error:', error);
    res.status(500).json({ error: 'Tier update failed' });
  }
});

// User login
app.post('/auth/login', rateLimiters.auth, async (req, res) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      return res.status(500).json({ error: 'Authentication error' });
    }
    if (!user) {
      return res.status(401).json({ error: info.message || 'Invalid credentials' });
    }

    // Auto-upgrade Wina to team tier on login (temporary beta fix)
    if (user.email === 'wina150197@gmail.com' && user.tier === 'free') {
      try {
        await db.run('UPDATE users SET tier = ? WHERE email = ?', ['team', user.email]);
        user.tier = 'team';
        console.log(`✅ Auto-upgraded ${user.email} to team tier`);
      } catch (error) {
        console.error('Failed to auto-upgrade user tier:', error);
      }
    }

    const token = generateToken(user);
    req.session.token = token;

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier
      },
      token
    });
  })(req, res);
});

// Google OAuth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
  passport.authenticate('google', { session: false }),
  (req, res) => {
    const token = generateToken(req.user);
    req.session.token = token;
    
    // Redirect to frontend with token
    res.redirect(`/?token=${token}`);
  }
);

// Get current user
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT id, email, name, tier, created_at FROM users WHERE id = ?', [req.user.id]);
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

// API Key management
app.post('/auth/api-keys', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'API key name is required' });
    }

    // Generate a random API key
    const apiKey = 'loca_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    const keyHash = await hashPassword(apiKey);

    const result = await db.run(`
      INSERT INTO api_keys (user_id, key_hash, name, tier)
      VALUES (?, ?, ?, ?)
    `, [req.user.id, keyHash, name, req.user.tier]);

    res.status(201).json({
      message: 'API key created successfully',
      apiKey, // Only show once
      id: result.id,
      name
    });
  } catch (error) {
    console.error('API key creation error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// List API keys (without showing actual keys)
app.get('/auth/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await db.all(`
      SELECT id, name, is_active, created_at, last_used_at
      FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json({ apiKeys: keys });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get API keys' });
  }
});

/** ------------------------- API: health & metrics ------------------------- */
// Basic health check
app.get('/api/health', (_req, res) => {
  res.json({ 
    ok: true, 
    uptime: process.uptime(), 
    model: 'gpt-4o',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version 
  });
});

// Detailed readiness check
app.get('/api/health/ready', async (req, res) => {
  try {
    const healthStatus = await healthCheckDependencies();
    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    
    res.status(statusCode).json(healthStatus);
    
    // Log health check
    log.info('Health check performed', {
      requestId: req.requestId,
      status: healthStatus.status,
      checks: Object.keys(healthStatus.checks).map(key => ({
        service: key,
        status: healthStatus.checks[key].status
      }))
    });
  } catch (error) {
    log.error('Health check failed', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler);

/** ------------------------- M5: Queue Management Admin Endpoints ------------------------- */
// Queue status and metrics
app.get('/api/admin/queues', requireAuth, async (req, res) => {
  try {
    if (!queueSystemInitialized) {
      return res.status(503).json({ error: 'Queue system not initialized' });
    }
    
    const queueMetrics = await Promise.all([
      getQueueMetrics('translation-long'),
      getQueueMetrics('file-processing'), 
      getQueueMetrics('batch-translation')
    ]);
    
    const queueHealth = await queueHealthCheck();
    
    res.json({
      queues: queueMetrics,
      health: queueHealth,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log.error('Failed to get queue status', { error: error.message });
    res.status(500).json({ error: 'Failed to get queue status' });
  }
});

// Job status endpoint
app.get('/api/admin/jobs/:queueName/:jobId', requireAuth, async (req, res) => {
  try {
    const { queueName, jobId } = req.params;
    
    if (!queueSystemInitialized) {
      return res.status(503).json({ error: 'Queue system not initialized' });
    }
    
    const jobStatus = await getJobStatus(queueName, jobId);
    
    if (!jobStatus) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(jobStatus);
  } catch (error) {
    log.error('Failed to get job status', { error: error.message });
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

// Circuit breaker status
app.get('/api/admin/circuit-breakers', requireAuth, (req, res) => {
  try {
    const stats = circuitBreakerService.getStats();
    const health = circuitBreakerService.healthCheck();
    
    res.json({
      stats,
      health,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log.error('Failed to get circuit breaker status', { error: error.message });
    res.status(500).json({ error: 'Failed to get circuit breaker status' });
  }
});

// Timeout manager status
app.get('/api/admin/timeouts', requireAuth, (req, res) => {
  try {
    const stats = timeoutManager.getStats();
    const health = timeoutManager.healthCheck();
    
    res.json({
      stats,
      health,
      configs: TIMEOUT_CONFIGS,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log.error('Failed to get timeout status', { error: error.message });
    res.status(500).json({ error: 'Failed to get timeout status' });
  }
});

/** ------------------------- Advanced Features Admin Endpoints ------------------------- */
// GDPR compliance endpoints
app.get('/api/privacy/info', (req, res) => {
  try {
    const info = gdprManager.getDataProcessingInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get privacy info' });
  }
});

app.post('/api/privacy/consent', requireAuth, async (req, res) => {
  try {
    const consentData = req.body;
    const validation = gdprManager.validateConsentRequest(consentData);
    
    if (!validation.valid) {
      return res.status(400).json({ errors: validation.errors });
    }
    
    const consentId = await gdprManager.recordConsent(req.user.id, consentData, req.ip);
    res.json({ success: true, consentId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

app.get('/api/privacy/export', requireAuth, async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const exportData = await gdprManager.exportUserData(req.user.id, format);
    
    res.setHeader('Content-Disposition', `attachment; filename="user-data-export.${format}"`);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.send(exportData);
    } else {
      res.json(exportData);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to export data' });
  }
});

app.delete('/api/privacy/delete-account', requireAuth, async (req, res) => {
  try {
    const options = req.body || {};
    const result = await gdprManager.deleteUserData(req.user.id, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete account data' });
  }
});

// Translation memory endpoints
app.get('/api/tm/suggestions', requireAuth, async (req, res) => {
  try {
    const { text, mode, targetLanguage, subStyle } = req.query;
    if (!text || !targetLanguage) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const suggestions = await translationMemory.getTranslationSuggestions(text, {
      targetLang: targetLanguage,
      mode,
      subStyle
    });
    
    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get TM suggestions' });
  }
});

app.post('/api/tm/feedback', requireAuth, async (req, res) => {
  try {
    const { tmId, score, feedback } = req.body;
    await translationMemory.updateQualityScore(tmId, score, feedback);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update TM feedback' });
  }
});

// Cache management endpoints
app.get('/api/admin/cache', requireAuth, async (req, res) => {
  try {
    const stats = translationCache.getStats();
    const health = translationCache.healthCheck();
    
    res.json({ stats, health, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

app.post('/api/admin/cache/invalidate', requireAuth, async (req, res) => {
  try {
    const { pattern } = req.body;
    await translationCache.invalidateCache(pattern || '*');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

// CDN management endpoints
app.get('/api/admin/cdn', requireAuth, async (req, res) => {
  try {
    const stats = await cdnManager.getCDNStatistics();
    const health = await cdnManager.healthCheck();
    
    res.json({ stats, health, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get CDN stats' });
  }
});

app.post('/api/admin/cdn/purge', requireAuth, async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'URLs must be an array' });
    }
    
    const result = await cdnManager.purgeCache(urls);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to purge CDN cache' });
  }
});

/** ------------------------- M6: Deployment Management Endpoints ------------------------- */
// Deployment status (using blue-green deployment manager if available)
app.get('/api/admin/deployment', requireAuth, (req, res) => {
  try {
    const { enhancedHealthCheck } = require('./deploy/blue-green-deploy');
    const deploymentHealth = enhancedHealthCheck();
    
    res.json({
      deployment: deploymentHealth.deployment,
      environment: NODE_ENV,
      version: require('./package.json').version,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    // Fallback if blue-green deployment is not available
    res.json({
      deployment: {
        current: 'single',
        status: 'running',
        healthy: true
      },
      environment: NODE_ENV,
      version: require('./package.json').version,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  }
});

// Enhanced health check with all M5/M6 components
app.get('/api/health/detailed', async (req, res) => {
  try {
    const healthStatus = await healthCheckDependencies();
    
    // Add M5 component health
    let queueHealth = { status: 'disabled' };
    if (queueSystemInitialized) {
      queueHealth = await queueHealthCheck();
    }
    
    const circuitBreakerHealth = circuitBreakerService.healthCheck();
    const timeoutHealth = timeoutManager.healthCheck();
    
    // Add M6 deployment health
    let deploymentHealth = { status: 'unknown' };
    try {
      const { enhancedHealthCheck } = require('./deploy/blue-green-deploy');
      deploymentHealth = enhancedHealthCheck();
    } catch (error) {
      deploymentHealth = { status: 'not_configured' };
    }
    
    const detailedHealth = {
      ...healthStatus,
      m5: {
        queues: queueHealth,
        circuitBreakers: circuitBreakerHealth,
        timeouts: timeoutHealth
      },
      m6: {
        deployment: deploymentHealth
      },
      system: {
        memory: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
        version: process.version,
        platform: process.platform
      }
    };
    
    const overallStatus = [
      healthStatus.status,
      queueHealth.status,
      circuitBreakerHealth.status,
      timeoutHealth.status
    ].includes('unhealthy') ? 'unhealthy' : 'healthy';
    
    detailedHealth.status = overallStatus;
    
    res.status(overallStatus === 'healthy' ? 200 : 503).json(detailedHealth);
    
  } catch (error) {
    log.error('Detailed health check failed', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/** ------------------------------------------------------------------------
 * Uploads: storage + helpers
 * ------------------------------------------------------------------------ */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const base = path.parse(file.originalname).name.replace(/[^\w.-]+/g, '_').slice(0, 60);
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

// Bigger files (100 MB)
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

async function fileToText(absPath, originalName) {
  const ext = path.extname(originalName || absPath).toLowerCase();
  const safeRead = (p) => fs.readFileSync(p, 'utf8');

  if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json' || ext === '.smi') {
    return safeRead(absPath);
  }

  if (ext === '.srt' || ext === '.vtt') {
    const parser = new SrtParser();
    const raw = safeRead(absPath);
    try {
      const cues = ext === '.vtt' ? parser.fromVtt(raw) : parser.fromSrt(raw);
      return cues.map(c => String(c.text || '').trim()).join('\n').trim();
    } catch {
      const cleaned = raw.replace(/^WEBVTT.*\n/i, '');
      try {
        const cues = parser.fromVtt(cleaned);
        return cues.map(c => String(c.text || '').trim()).join('\n').trim();
      } catch {
        return raw;
      }
    }
  }

  if (ext === '.docx') {
    console.log(`📄 Processing DOCX file: ${originalName}`);
    const { value } = await mammoth.extractRawText({ path: absPath });
    return value || '';
  }

  if (ext === '.pdf') {
    console.log(`📄 Processing PDF file: ${originalName}`);
    // For large PDFs, process in chunks to prevent memory issues
    const stats = fs.statSync(absPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 10) {
      console.log(`📄 Large PDF detected (${fileSizeMB.toFixed(2)}MB), processing with optimizations...`);
    }
    
    const data = await pdfParse(fs.readFileSync(absPath), {
      // Optimize for large files
      max: fileSizeMB > 20 ? 50 : 0, // Limit pages for very large files
      version: 'v1.10.100'
    });
    return (data && data.text) ? data.text : '';
  }

  try { return safeRead(absPath); } catch { return ''; }
}

/** ------------------------- API: upload ------------------------- */
// Guest mode middleware - allows both authenticated users and guests
const allowGuests = (req, res, next) => {
  // Development bypass if enabled
  if (NODE_ENV === 'development' && process.env.DEV_AUTH_BYPASS === 'true') {
    req.user = {
      id: 'dev-user-' + Date.now(),
      email: 'dev@localhost',
      name: 'Development User',
      tier: 'team'
    };
    return next();
  }
  
  // Check for guest ID header
  const guestId = req.headers['x-guest-id'];
  if (guestId && guestId.startsWith('guest_')) {
    req.user = {
      id: guestId,
      email: null,
      name: 'Guest User',
      tier: 'free',
      isGuest: true
    };
    return next();
  }
  
  // Try API key first, then JWT auth
  if (req.headers['x-api-key']) {
    return requireApiKey(req, res, next);
  } else {
    return requireAuth(req, res, next);
  }
};

app.post('/api/upload',
  allowGuests,
  rateLimiters.upload,
  quotaMiddleware,
  upload.single('file'),
  async (req, res) => {
  // secured localization — delete uploaded file after parsing; never log bodies
  let absPath = null;
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

    absPath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileSizeMB = req.file.size / (1024 * 1024);
    
    // Log large file processing
    if (fileSizeMB > 5) {
      console.log(`📁 Processing large file: ${req.file.originalname} (${fileSizeMB.toFixed(2)}MB)`);
    }
    const basePayload = {
      ok: true,
      file: {
        originalName: req.file.originalname,
        storedAs: path.basename(absPath),
        size: req.file.size,
        ext,
        mime: req.file.mimetype
      }
    };

    if (ext === '.srt' || ext === '.vtt') {
      const raw = fs.readFileSync(absPath, 'utf8');
      const parser = new SrtParser();
      let cuesRaw;

      try {
        cuesRaw = ext === '.vtt' ? parser.fromVtt(raw) : parser.fromSrt(raw);
      } catch {
        const cleaned = raw.replace(/^WEBVTT.*\n/i, '');
        cuesRaw = parser.fromVtt(cleaned);
      }

      const toSrtTime = t => String(t || '').replace('.', ',');
      const cues = (cuesRaw || []).map(c => ({
        start: toSrtTime(c.startTime),
        end: toSrtTime(c.endTime),
        text: (c.text || '').toString().replace(/\r/g, '').trim()
      }));

      const text = cues.map(c => c.text).join('\n').trim();

      // respond without keeping file
      res.json({ ...basePayload, text, cues });
    } else {
      const text = await fileToText(absPath, req.file.originalname);
      res.json({ ...basePayload, text });
    }
  } catch (e) {
    console.error('upload error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to process the uploaded file.' });
  } finally {
    if (absPath) {
      fs.unlink(absPath, () => {}); // best-effort delete
    }
  }
});

/** ------------------------- API: download ------------------------- */
app.post('/api/download', async (req, res) => {
  try {
    const { text = '', filename = 'translation', format = 'txt', type, cues = [] } = req.body || {};
    const safeName = String(filename || 'translation').replace(/[^\w.-]+/g, '_').slice(0, 80);

    const isSrt = (type || format || '').toString().toLowerCase() === 'srt';
    if (isSrt && Array.isArray(cues) && cues.length) {
      const srt = cues.map((c, i) => {
        const n = (c.index ? Number(c.index) : (i + 1));
        const start = c.start || '00:00:00,000';
        const end = c.end || '00:00:00,000';
        const body = (c.text || '').toString().replace(/\r/g, '').trim();
        return `${n}\n${start} --> ${end}\n${body}\n`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.srt"`);
      return res.send(srt);
    }

    if (!text.trim() && !isSrt) {
      return res.status(400).json({ ok: false, error: 'Missing text.' });
    }

    if (format === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.txt"`);
      return res.send(text);
    }

    if (format === 'docx') {
      const { Document, Packer, Paragraph, TextRun } = require('docx');
      const blocks = String(text).split(/\r?\n\r?\n/);
      const paragraphs = blocks.map(block => {
        const lines = block.split(/\r?\n/);
        const children = lines.map((line, i) =>
          i === 0 ? new TextRun(line) : new TextRun({ text: line, break: true })
        );
        return new Paragraph({ children });
      });
      const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
      const buffer = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', mime.lookup('docx') || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
      return res.send(buffer);
    }

    if (format === 'pdf') {
      const PDFDocument = require('pdfkit');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
      const pdf = new PDFDocument({ size: 'A4', margin: 50 });
      pdf.pipe(res);
      pdf.fontSize(12).text(text, { align: 'left' });
      pdf.end();
      return;
    }

    return res.status(400).json({ ok: false, error: 'Unsupported format. Use txt, docx, or pdf (or type: "srt" with cues).' });
  } catch (e) {
    console.error('download error:', e);
    res.status(500).json({ ok: false, error: 'Failed to generate file.' });
  }
});

/** ------------------------- API: download-zip (batch) ------------------------- */
/**
 * Accepts:
 * {
 *   zipname: "localized_bundle",
 *   files: [
 *     { filename: "doc1.localized", format: "txt"|"docx"|"pdf", text: "..." },
 *     { filename: "video.localized", type: "srt", format: "srt", cues: [{start,end,text}, ...] }
 *   ]
 * }
 * Returns: ZIP (no compression, store) without external deps.
 */
app.post('/api/download-zip',
  (req, res, next) => {
    // Try API key first, then JWT auth
    if (req.headers['x-api-key']) {
      return requireApiKey(req, res, next);
    } else {
      return requireAuth(req, res, next);
    }
  },
  checkTierPermission('zip'), // ZIP download requires Pro or Team tier
  async (req, res) => {
  try {
    const { files = [], zipname = 'localized' } = req.body || {};
    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ ok: false, error: 'No files to pack.' });
    }

    // helpers
    const toSrtBuffer = (spec) => {
      const cues = Array.isArray(spec.cues) ? spec.cues : [];
      const srt = cues.map((c, i) => {
        const n = (c.index ? Number(c.index) : (i + 1));
        const start = (c.start || '00:00:00,000');
        const end = (c.end || '00:00:00,000');
        const body = (c.text || '').toString().replace(/\r/g, '').trim();
        return `${n}\n${start} --> ${end}\n${body}\n`;
      }).join('\n');
      return Buffer.from(srt, 'utf8');
    };

    const toDocxBuffer = async (text) => {
      const { Document, Packer, Paragraph, TextRun } = require('docx');
      const blocks = String(text || '').split(/\r?\n\r?\n/);
      const paragraphs = blocks.map(block => {
        const lines = block.split(/\r?\n/);
        const children = lines.map((line, i) =>
          i === 0 ? new TextRun(line) : new TextRun({ text: line, break: true })
        );
        return new Paragraph({ children });
      });
      const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
      return await Packer.toBuffer(doc);
    };

    const toPdfBuffer = async (text) => {
      const PDFDocument = require('pdfkit');
      const { PassThrough } = require('stream');
      const chunks = [];
      return await new Promise((resolve) => {
        const stream = new PassThrough();
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));

        const pdf = new PDFDocument({ size: 'A4', margin: 50 });
        pdf.pipe(stream);
        pdf.fontSize(12).text(String(text || ''), { align: 'left' });
        pdf.end();
      });
    };

    // --- Minimal ZIP (store, no compression), no external deps ---
    // CRC32 table
    const CRC_TABLE = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
      }
      return t;
    })();
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const dosDateTime = (d) => {
      const dt = d || new Date();
      const time =
        ((dt.getHours() & 0x1f) << 11) |
        ((dt.getMinutes() & 0x3f) << 5) |
        (Math.floor(dt.getSeconds() / 2) & 0x1f);
      const date =
        (((dt.getFullYear() - 1980) & 0x7f) << 9) |
        ((dt.getMonth() + 1) << 5) |
        (dt.getDate() & 0x1f);
      return [time, date];
    };
    const u16 = (n) => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(n >>> 0, 0);
      return b;
    };
    const u32 = (n) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n >>> 0, 0);
      return b;
    };

    const buildZip = (entries) => {
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      const [dTime, dDate] = dosDateTime(new Date());

      for (const e of entries) {
        const name = String(e.name || 'file').replace(/\\/g, '/');
        const nameBuf = Buffer.from(name, 'utf8');
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data || ''), 'utf8');

        const crc = crc32(data);
        const compSize = data.length;      // store (no compression)
        const uncompSize = data.length;
        const gpFlags = 0x0800;            // UTF-8 names
        const method = 0;                  // store
        const ver = 20;                    // 2.0

        // Local header
        const localHeader =
          Buffer.concat([
            u32(0x04034b50),          // local file header signature
            u16(ver),                 // version needed
            u16(gpFlags),             // general purpose bit flag (UTF-8)
            u16(method),              // method = store
            u16(dTime), u16(dDate),   // last mod time/date
            u32(crc),                 // CRC-32
            u32(compSize),            // compressed size
            u32(uncompSize),          // uncompressed size
            u16(nameBuf.length),      // file name length
            u16(0)                    // extra field length
          ]);

        localParts.push(localHeader, nameBuf, data);

        // Central directory header
        const centralHeader =
          Buffer.concat([
            u32(0x02014b50),          // central file header signature
            u16(0x031E),              // version made by (arbitrary)
            u16(ver),                 // version needed
            u16(gpFlags),
            u16(method),
            u16(dTime), u16(dDate),
            u32(crc),
            u32(compSize),
            u32(uncompSize),
            u16(nameBuf.length),
            u16(0),                   // extra length
            u16(0),                   // comment length
            u16(0),                   // disk number start
            u16(0),                   // internal attrs
            u32(0),                   // external attrs
            u32(offset)               // relative offset of local header
          ]);

        centralParts.push(centralHeader, nameBuf);

        offset += localHeader.length + nameBuf.length + data.length;
      }

      const centralStart = offset;
      const centralBuf = Buffer.concat(centralParts);
      const centralSize = centralBuf.length;

      const eocd =
        Buffer.concat([
          u32(0x06054b50),        // end of central dir signature
          u16(0),                 // number of this disk
          u16(0),                 // number of the disk with the start
          u16(entries.length),    // total entries on this disk
          u16(entries.length),    // total entries
          u32(centralSize),       // size of the central dir
          u32(centralStart),      // offset of start of central dir
          u16(0)                  // comment length
        ]);

      return Buffer.concat([...localParts, centralBuf, eocd]);
    };

    // Build all files’ buffers
    const out = [];
    for (const f of files) {
      try {
        const base = String(f.filename || 'file').replace(/[^\w.-]+/g,'_').slice(0,80);
        const kind = (f.type || f.format || '').toString().toLowerCase();
        if (kind === 'srt') {
          out.push({ name: `${base}.srt`, data: toSrtBuffer(f) });
          continue;
        }

        const fmt = (f.format || 'txt').toLowerCase();
        const text = (f.text || '').toString();
        if (fmt === 'txt') {
          out.push({ name: `${base}.txt`, data: Buffer.from(text, 'utf8') });
        } else if (fmt === 'docx') {
          out.push({ name: `${base}.docx`, data: await toDocxBuffer(text) });
        } else if (fmt === 'pdf') {
          out.push({ name: `${base}.pdf`, data: await toPdfBuffer(text) });
        } else {
          out.push({ name: `${base}.txt`, data: Buffer.from(text, 'utf8') });
        }
      } catch (e) {
        console.error('pack item error:', e);
        // continue packing others
      }
    }

    const zipBuf = buildZip(out);
    const safeZip = String(zipname).replace(/[^\w.-]+/g,'_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeZip}.zip"`);
    return res.end(zipBuf);
  } catch (e) {
    console.error('download-zip error:', e);
    try { res.status(500).json({ ok:false, error:'Failed to create ZIP.' }); } catch {}
  }
});

/** ------------------------- API: translate ------------------------- */
// Apply authentication (either JWT or API key), rate limiting, quota, and input validation
app.post('/api/translate', 
  ensureProfile,
  (req, res, next) => {
    // Development bypass if enabled
    if (NODE_ENV === 'development' && process.env.DEV_AUTH_BYPASS === 'true') {
      req.user = {
        id: 'dev-user-' + Date.now(),
        email: 'dev@localhost',
        name: 'Development User',
        tier: 'team'
      };
      return next();
    }
    
    // Try API key first, then JWT auth
    if (req.headers['x-api-key']) {
      return requireApiKey(req, res, next);
    } else {
      return requireAuth(req, res, next);
    }
  },
  rateLimiters.translation,
  quotaMiddleware,
  validateInputSize,
  idempotencyMiddleware,
  async (req, res) => {
  try {
    const { text = '', mode = '', targetLanguage = '', subStyle = '', rephrase = false, injections = '' } = req.body || {};
    if (!text || !mode) return res.status(400).json({ result: 'Missing text or mode.' });

    const prompt = buildPrompt({ text, mode, subStyle, targetLanguage, rephrase, injections });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: pickTemperature(mode, subStyle, rephrase),
      messages: [
        { role: 'system', content: 'You are an expert localization and translation assistant.' },
        { role: 'user', content: prompt },
      ],
    });

    const raw = (completion.choices?.[0]?.message?.content || '').trim();
    const body = extractResultTagged(raw) || '(no output)';
    const clean = sanitizeWithSource(body, text, targetLanguage);
    
    // Record usage for analytics and quota tracking
    await recordUsage(req, 'translate', 0, text.length + clean.length);
    try { updateMonthlyUsage({ userId: req.user?.id, requests: 1, inputChars: text.length, outputChars: clean.length }); } catch {}
    
    // Record observability metrics
    recordMetrics.translation('single', mode, targetLanguage, req.user?.tier || 'anonymous', true, text.length + clean.length);
    log.translation('single', text.length, clean.length, mode, targetLanguage, req.user?.id, Date.now() - req.startTime, true);
    
    return res.json({ result: clean });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ result: 'Something went wrong!' });
  }
});

/** ------------------------- API: translate-batch (TPM-safe microbatching) ------------------------- */
/**
 * Strategy:
 * - Combine many items into a single model call (JSON array out), cutting prompt overhead massively.
 * - Chunk by *estimated tokens* to stay under a safe per-request ceiling.
 * - Apply robust backoff on 429/5xx using Retry-After if provided.
 * - Preserve ordering; return exactly one string per input item.
 */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return Math.max(0, Math.floor(ms * (0.85 + Math.random() * 0.3))); }

// Simple, fast token estimator (good enough for budgeting)
const CHARS_PER_TOKEN = 4; // ~4 chars per token (mixed Latin)
const estimateTokens = (s = '') => Math.ceil(String(s).length / CHARS_PER_TOKEN);

/**
 * Build one prompt that instructs the model to translate N items and return a JSON array
 * of N strings. We keep your style guard + subtitle overrides + QA checklist.
 */
function buildBatchPrompt({ items, mode, subStyle, targetLanguage, rephrase, injections }) {
  const modeKey = safeSlugify(mode);
  const subKey = subStyle ? safeSlugify(subStyle) : 'general';
  const byMode = PROMPTS[modeKey] || {};
  const baseTmpl =
    byMode[subKey] ||
    byMode['general'] ||
    `Translate each element of ITEMS into {TARGET_LANG}.\n\nText:\n{TEXT}`;

  const needsSubtitleRules =
    modeKey === 'dubbing' || subKey === 'subtitling' || subKey === 'dialogue';

  const QA_BLOCK = `
QUALITY CHECK BEFORE RETURN:
- Context preservation: Maintain emotional tone and implied meaning for each item.
- Punctuation preservation: Keep exact punctuation from source (... stays ..., ? stays ?, ! stays !).
- Kinship accuracy: Default to family roles over formal titles when ambiguous.
- Number format: Keep Arabic digits as digits unless target language requires spelling.
- Terminology consistency across items.
- Locale formats: use {TARGET_LANG} conventions (dates, numbers, decimal separators).
- NO lists, NO dashes; plain text.
- Output MUST be returned ONLY between <result> and </result> and MUST be a JSON array of strings with the SAME LENGTH as ITEMS.
- HARD 1:1 CHECK: The output array length MUST equal ITEMS length, and each index must correspond to its source index without moving words across items (no merging/splitting between indices). Example: If ITEMS[i] is "di nascosto", the output[i] MUST be "secretly" (or equivalent), and output[i-1] MUST NOT receive that adverb.
`.trim();

  const renderedBase = safeRenderTemplate(baseTmpl, {
    TARGET_LANG: targetLanguage || 'the same language as the input',
    TEXT: 'Apply the same style rules to every element of ITEMS.'
  });

  const injBlock = renderInjections(injections);

  const header = `
You are an expert localization and translation assistant with advanced skills in cultural adaptation, style consistency, and terminology accuracy.
Always strictly follow the provided style, substyle, tone, and language style guidelines.
${STYLE_GUARD}
${needsSubtitleRules ? SUBTITLE_OVERRIDES : ''}

${injBlock ? injBlock + '\n' : ''}

${safeRenderTemplate(QA_BLOCK, {
  TARGET_LANG: targetLanguage || 'the same language as the input'
})}

${renderedBase}

BATCH INSTRUCTIONS:
- ITEMS is a JSON array of ${items.length} strings.
- ${rephrase ? 'REPHRASE each string in its original language' : `TRANSLATE/LOCALIZE each string into ${targetLanguage || 'the target language'}`}
  according to the selected style (${modeKey}${subStyle ? ` / ${subKey}` : ''}).
- Return ONLY a JSON array of ${items.length} strings, in the SAME order, 1-to-1 with ITEMS.
- Do NOT merge or split lines. Do NOT add indices, speakers, or extra punctuation.
- CRITICAL: Keep each item in its own output index. If the source has a standalone cue like "di nascosto", the output must be exactly the adverb equivalent in the SAME index (e.g., "secretly"). Never move it to the previous line.
- The ONLY thing in your final output must be the JSON array inside <result> tags.

ITEMS:
${JSON.stringify(items, null, 2)}

Return only the JSON array strictly between <result> and </result>.

<result>
`.trim();

  return header;
}

/**
 * Chunk items to keep each request under a safe token budget.
 */
function chunkByTokenBudget(items, opts = {}) {
  const {
    maxTokensPerRequest = Number(process.env.BATCH_TOKENS || 7000),
    overheadTokens = 1200,
    outputFactor = 1.15,
    maxItemsPerChunk = 250
  } = opts;

  const chunks = [];
  let cur = [];
  let curInTok = 0;

  for (const it of items) {
    const tIn = estimateTokens(it || '');
    const projectedIn = curInTok + tIn;
    const projectedOut = Math.ceil(projectedIn * outputFactor);
    const projectedTotal = overheadTokens + projectedIn + projectedOut;

    if (cur.length >= maxItemsPerChunk || (cur.length > 0 && projectedTotal > maxTokensPerRequest)) {
      chunks.push(cur);
      cur = [it];
      curInTok = tIn;
    } else {
      cur.push(it);
      curInTok = projectedIn;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Extract JSON array safely from <result>...</result> or raw content */
function parseJsonArrayStrict(raw = '', expectedLen = null) {
  const tagged = extractResultTagged(raw) || raw;
  let text = tagged.trim();

  // strip any accidental code fences or markdown
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  // If it contains surrounding text, try to cut to first [...] block
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }

  let arr = [];
  try {
    arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('Not an array');
  } catch {
    // last resort: split by lines
    arr = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  }

  if (expectedLen != null) {
    if (arr.length > expectedLen) arr = arr.slice(0, expectedLen);
    while (arr.length < expectedLen) arr.push('');
  }
  arr = arr.map(x => (x == null ? '' : String(x)));
  return arr;
}

/** Robust retry wrapper for OpenAI calls with Retry-After + exponential backoff */
async function callOpenAIWithRetry({ messages, temperature }) {
  const model = 'gpt-4o';
  let attempt = 0;
  const maxAttempts = 8;

  while (true) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature,
        messages
      });
      return completion.choices?.[0]?.message?.content || '';
    } catch (e) {
      attempt++;
      const status = e?.status || e?.code;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

      if (!isRetryable || attempt >= maxAttempts) {
        console.error('OpenAI error (giving up):', e?.message || e);
        throw e;
      }

      // Honor Retry-After headers if present
      let waitMs = 0;
      try {
        const hdrs = e?.headers;
        const get = (k) => {
          if (!hdrs) return null;
          if (typeof hdrs.get === 'function') return hdrs.get(k);
          return hdrs[k] || hdrs?.[k.toLowerCase()] || null;
        };
        const raMs = Number(get('retry-after-ms'));
        const raSec = Number(get('retry-after'));
        if (Number.isFinite(raMs) && raMs > 0) waitMs = raMs;
        else if (Number.isFinite(raSec) && raSec > 0) waitMs = raSec * 1000;
      } catch {}

      // Fallback exponential backoff (+ jitter)
      if (!waitMs) {
        const base = Math.min(12000, 600 * (2 ** attempt)); // cap ~12s
        waitMs = base;
      }
      waitMs = jitter(waitMs);
      console.warn(`Rate limited / transient error. Retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})…`);
      await sleep(waitMs);
    }
  }
}

app.post('/api/translate-batch',
  allowGuests,
  rateLimiters.translation,
  quotaMiddleware,
  checkTierPermission('batch'), // Batch requires Pro or Team tier
  validateInputSize,
  idempotencyMiddleware,
  async (req, res) => {
  try {
    const {
      items = [],
      mode = '',
      targetLanguage = '',
      subStyle = '',
      rephrase = false,
      injections = ''
    } = req.body || {};

    if (!Array.isArray(items) || !items.length || !mode) {
      return res.status(400).json({ items: [], error: 'Missing items or mode.' });
    }

    const chunks = chunkByTokenBudget(items, {
      maxTokensPerRequest: Number(process.env.BATCH_TOKENS || 7000),
      overheadTokens: 1200,
      outputFactor: 1.15,
      maxItemsPerChunk: 250
    });

    const temperature = pickTemperature(mode, subStyle, rephrase);
    const results = [];

    for (const chunk of chunks) {
      const prompt = buildBatchPrompt({
        items: chunk,
        mode,
        subStyle,
        targetLanguage,
        rephrase,
        injections
      });

      const raw = await callOpenAIWithRetry({
        messages: [
          { role: 'system', content: 'You are an expert localization and translation assistant.' },
          { role: 'user', content: prompt }
        ],
        temperature
      });

      let arr = parseJsonArrayStrict(raw, chunk.length);

      // Final sanitation per line with source awareness
      for (let i = 0; i < arr.length; i++) {
        arr[i] = sanitizeWithSource(arr[i] || '', chunk[i] || '', targetLanguage);
      }

      results.push(...arr);
    }

    // Record usage for analytics and quota tracking
    const inputChars = items.join('').length; const outputChars = results.join('').length;
    const totalChars = inputChars + outputChars;
    await recordUsage(req, 'translate-batch', 0, totalChars);
    try { updateMonthlyUsage({ userId: req.user?.id, requests: 1, inputChars, outputChars }); } catch {}
    
    // Record observability metrics
    recordMetrics.translation('batch', mode, targetLanguage, req.user?.tier || 'anonymous', true, totalChars);
    log.translation('batch', items.join('').length, results.join('').length, mode, targetLanguage, req.user?.id, Date.now() - req.startTime, true);
    
    return res.json({ items: results });
  } catch (e) {
    console.error('translate-batch error (final):', e);
    return res.status(500).json({ items: [], error: 'Batch translation failed.' });
  }
});

/** ------------------------- API: align ------------------------- */
app.post('/api/align', async (req, res) => {
  try {
    const { src = '', tgt = '', srcLang = 'auto', tgtLang = '' } = req.body || {};
    if (!src.trim() || !tgt.trim()) return res.json([]);

    const sys = `You align source and target texts at the word/short-phrase level.
- Output ONLY compact JSON: [{"src":"<exact span from source>","tgt":"<exact span from target>"}...]
- Use substrings that literally appear in each text (case-insensitive OK, but keep original casing in output).
- Prefer content words/short phrases (1–3 words). Avoid articles/punctuation.
- 10–60 pairs max. No duplicates.`;

    const user = `
SOURCE (${srcLang}):
<<<
${src}
>>>

TARGET (${tgtLang}):
<<<
${tgt}
>>>

Return ONLY the JSON array.`;

    const raw = await callOpenAIWithRetry({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      temperature: 0.10
    });

    let jsonText = raw;
    const m = raw.match(/\[([\s\S]*?)\]/);
    if (m) jsonText = `[${m[1]}]`;

    let pairs = [];
    try { pairs = JSON.parse(jsonText); } catch { pairs = []; }

    const seen = new Set();
    const clean = [];
    for (const p of pairs) {
      if (!p || !p.src || !p.tgt) continue;
      const key = `${String(p.src).toLowerCase()}|${String(p.tgt).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ src: String(p.src), tgt: String(p.tgt) });
    }

    res.json(clean);
  } catch (e) {
    console.error('align error', e);
    res.json([]); // graceful fallback
  }
});

/** ------------------------- API: Phrasebook (server-backed) ------------------------- */
/** Simple per-user storage keyed by X-UID header. */
const DATA_DIR = path.join(__dirname, 'userdb');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function pbPath(uid){ return path.join(DATA_DIR, `phrasebook_${String(uid||'anon').replace(/[^\w.-]+/g,'_')}.json`); }
function pbRead(uid){
  try { return JSON.parse(fs.readFileSync(pbPath(uid), 'utf8')); } catch { return { items: [] }; }
}
function pbWrite(uid, data){ try { fs.writeFileSync(pbPath(uid), JSON.stringify(data||{items:[]}), 'utf8'); } catch(e){ console.error('pb save', e); } }
function getUID(req){ return req.headers['x-uid'] || req.query.uid || 'anon'; }

app.get('/api/phrasebook', requireAuth, ensureProfile, async (req,res)=>{
  try{
    const userId = req.user?.id || getUID(req);
    // Prefer Supabase REST with service role to avoid RLS issues on direct PG
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/phrasebook_items`);
      url.searchParams.set('user_id', `eq.${userId}`);
      url.searchParams.set('select', 'id,src_text,tgt_text,src_lang,tgt_lang,created_at');
      url.searchParams.set('order', 'created_at.desc');
      const r = await fetch(url.toString(), {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      });
      if (!r.ok) throw new Error(`supabase rest list ${r.status}`);
      const rows = await r.json();
      const items = (rows||[]).map(r=>({
        id: String(r.id), srcLang: r.src_lang||'', tgtLang: r.tgt_lang||'', srcText: r.src_text||'', tgtText: r.tgt_text||'', createdAt: new Date(r.created_at).getTime()||Date.now()
      }));
      return res.json({ items });
    }
    // Fallback to PG (dev/local)
    const rows = await prisma.$queryRaw`select id, src_text, tgt_text, src_lang, tgt_lang, extract(epoch from created_at)*1000 as created_ms from public.phrasebook_items where user_id = ${userId} order by created_at desc`;
    const items = (rows||[]).map(r=>({ id: String(r.id), srcLang: String(r.src_lang||''), tgtLang: String(r.tgt_lang||''), srcText: String(r.src_text||''), tgtText: String(r.tgt_text||''), createdAt: Number(r.created_ms)||Date.now() }));
    return res.json({ items });
  }catch(e){ console.error('pb list', e?.message||e); res.status(500).json({ items: [] }); }
});

app.post('/api/phrasebook/add', requireAuth, ensureProfile, express.json(), async (req,res)=>{
  try{
    const userId = req.user?.id || getUID(req);
    const it = req.body?.item || {};
    if(!it) return res.status(400).json({ ok:false, error:'Bad item.' });
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = `${process.env.SUPABASE_URL}/rest/v1/phrasebook_items`;
      const r = await fetch(url, {
        method:'POST',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':'application/json',
          'Prefer':'return=representation'
        },
        body: JSON.stringify({ user_id: userId, src_text: String(it.srcText||''), tgt_text: String(it.tgtText||''), src_lang: String(it.srcLang||'Auto'), tgt_lang: String(it.tgtLang||'') })
      });
      if (!r.ok) throw new Error(`supabase rest insert ${r.status}`);
      const rows = await r.json();
      const created = Array.isArray(rows)&&rows[0]?rows[0]:{};
      return res.json({ ok:true, id: String(created.id||''), createdAt: new Date(created.created_at||Date.now()).getTime() });
    }
    // Fallback PG
    const rows = await prisma.$queryRaw`insert into public.phrasebook_items (user_id, src_text, tgt_text, src_lang, tgt_lang) values (${userId}, ${String(it.srcText||'')}, ${String(it.tgtText||'')}, ${String(it.srcLang||'Auto')}, ${String(it.tgtLang||'')}) returning id, extract(epoch from created_at)*1000 as created_ms`;
    const created = Array.isArray(rows)&&rows[0]?rows[0]:{};
    return res.json({ ok:true, id: String(created.id||''), createdAt: Number(created.created_ms)||Date.now() });
    const data = pbRead(userId);
    data.items = Array.isArray(data.items)?data.items:[];
    const withId = it.id ? it : { ...it, id: 'pb_'+Date.now().toString(36)+Math.random().toString(36).slice(2) };
    data.items.unshift(withId);
    pbWrite(userId, data);
    res.json({ ok:true, id: withId.id });
  }catch(e){ console.error('pb add', e?.message||e); res.status(500).json({ ok:false }); }
});

app.post('/api/phrasebook/delete', requireAuth, ensureProfile, express.json(), async (req,res)=>{
  try{
    const userId = req.user?.id || getUID(req);
    const id = req.body?.id;
    if(!id) return res.status(400).json({ ok:false, error:'Missing id.' });
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/phrasebook_items`);
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${userId}`);
      const r = await fetch(url.toString(), {
        method: 'DELETE',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'return=minimal'
        }
      });
      if (!r.ok) throw new Error(`supabase rest delete ${r.status}`);
      return res.json({ ok:true });
    }
    // Fallback PG (dev)
    const result = await prisma.$executeRaw`delete from public.phrasebook_items where id = ${id} and user_id = ${userId}`;
    return res.json({ ok:true });
    const data = pbRead(userId);
    data.items = (data.items||[]).filter(x=>String(x.id)!==String(id));
    pbWrite(userId, data);
    res.json({ ok:true });
  }catch(e){ console.error('pb del', e?.message||e); res.status(500).json({ ok:false }); }
});

/** ------------------------- API: Brand Kits ------------------------- */
app.get('/api/brand-kits', requireAuth, ensureProfile, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/brand_kits`);
      url.searchParams.set('user_id', `eq.${userId}`);
      url.searchParams.set('select', '*');
      url.searchParams.set('order', 'created_at.desc');
      const r = await fetch(url.toString(), { headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
      if (!r.ok) throw new Error(`supabase rest list ${r.status}`);
      const rows = await r.json();
      return res.json({ items: rows });
    }
    if (!prisma) return res.json({ items: [] });
    const rows = await prisma.brand_kits.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' } });
    res.json({ items: rows });
  } catch (e) { console.error('brand list', e); res.status(500).json({ items: [] }); }
});

app.post('/api/brand-kits', requireAuth, ensureProfile, express.json(), async (req, res) => {
  try {
    const userId = req.user?.id;
    const { name = 'My Brand', tone = [], forbidden_words = [], style_notes = '' } = req.body || {};
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = `${process.env.SUPABASE_URL}/rest/v1/brand_kits`;
      const r = await fetch(url, {
        method:'POST',
        headers:{ 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', 'Prefer':'return=representation' },
        body: JSON.stringify({ user_id: userId, name, tone, forbidden_words, style_notes })
      });
      if (!r.ok) throw new Error(`supabase rest create ${r.status}`);
      const rows = await r.json();
      return res.json({ ok:true, item: Array.isArray(rows)&&rows[0]?rows[0]:rows });
    }
    if (!prisma) return res.status(503).json({ ok:false, error:'DB unavailable' });
    const row = await prisma.brand_kits.create({ data: { user_id: userId, name, tone, forbidden_words, style_notes } });
    res.json({ ok:true, item: row });
  } catch (e) { console.error('brand create', e); res.status(500).json({ ok:false }); }
});

app.put('/api/brand-kits/:id', requireAuth, ensureProfile, express.json(), async (req, res) => {
  try {
    const userId = req.user?.id; const id = req.params.id;
    const { name, tone, forbidden_words, style_notes } = req.body || {};
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/brand_kits`);
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${userId}`);
      const r = await fetch(url.toString(), {
        method:'PATCH',
        headers:{ 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', 'Prefer':'return=representation' },
        body: JSON.stringify({ name, tone, forbidden_words, style_notes })
      });
      if (!r.ok) throw new Error(`supabase rest update ${r.status}`);
      const rows = await r.json();
      return res.json({ ok:true, item: Array.isArray(rows)&&rows[0]?rows[0]:rows });
    }
    if (!prisma) return res.status(503).json({ ok:false });
    const row = await prisma.brand_kits.update({ where: { id }, data: { name, tone, forbidden_words, style_notes } });
    res.json({ ok:true, item: row });
  } catch (e) { console.error('brand update', e); res.status(500).json({ ok:false }); }
});

app.delete('/api/brand-kits/:id', requireAuth, ensureProfile, async (req, res) => {
  try {
    const userId = req.user?.id; const id = req.params.id;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/brand_kits`);
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${userId}`);
      const r = await fetch(url.toString(), { method:'DELETE', headers:{ 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Prefer':'return=minimal' } });
      if (!r.ok) throw new Error(`supabase rest delete ${r.status}`);
      return res.json({ ok:true });
    }
    if (!prisma) return res.status(503).json({ ok:false });
    await prisma.brand_kits.delete({ where: { id } });
    res.json({ ok:true });
  } catch (e) { console.error('brand delete', e); res.status(500).json({ ok:false }); }
});

/** ------------------------- API: Glossary ------------------------- */
app.get('/api/glossary', requireAuth, ensureProfile, async (req, res) => {
  try { const userId = req.user?.id; if (!prisma) return res.json({ items: [] }); const rows = await prisma.glossary_terms.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' } }); res.json({ items: rows }); }
  catch (e) { console.error('gloss list', e); res.status(500).json({ items: [] }); }
});

app.post('/api/glossary', requireAuth, ensureProfile, express.json(), async (req, res) => {
  try {
    if (!prisma) return res.status(503).json({ ok:false });
    const userId = req.user?.id; const { src = '', tgt = '', lock = false, case_hint = null } = req.body || {};
    const row = await prisma.glossary_terms.create({ data: { user_id: userId, src, tgt, lock, case_hint } });
    res.json({ ok:true, item: row });
  } catch (e) { console.error('gloss create', e); res.status(500).json({ ok:false }); }
});

app.put('/api/glossary/:id', requireAuth, ensureProfile, express.json(), async (req, res) => {
  try { if (!prisma) return res.status(503).json({ ok:false }); const { src, tgt, lock, case_hint } = req.body || {}; const row = await prisma.glossary_terms.update({ where: { id: req.params.id }, data: { src, tgt, lock, case_hint } }); res.json({ ok:true, item: row }); }
  catch (e) { console.error('gloss update', e); res.status(500).json({ ok:false }); }
});

app.delete('/api/glossary/:id', requireAuth, ensureProfile, async (req, res) => {
  try { if (!prisma) return res.status(503).json({ ok:false }); await prisma.glossary_terms.delete({ where: { id: req.params.id } }); res.json({ ok:true }); }
  catch (e) { console.error('gloss delete', e); res.status(500).json({ ok:false }); }
});

/** ------------------------- API: Usage (monthly) ------------------------- */
app.get('/api/usage/monthly', requireAuth, ensureProfile, async (req, res) => {
  try {
    const userId = req.user?.id; if (!prisma) return res.json({ items: [] });
    const rows = await prisma.$queryRawUnsafe(
      'SELECT month, requests, input_tokens, output_tokens FROM public.usage_monthly WHERE user_id = $1 ORDER BY month DESC LIMIT 12',
      userId
    );
    res.json({ items: rows });
  } catch (e) { console.error('usage monthly', e); res.status(500).json({ items: [] }); }
});

/** ------------------------- API: Current Usage ------------------------- */
app.get('/api/usage/current', 
  allowGuests,
  async (req, res) => {
  try {
    const userId = req.user?.id;
    const isGuest = req.user?.isGuest === true;
    const tier = req.user?.tier || 'free';
    const tierConfig = TIERS[tier];
    
    console.log('🔍 Usage API Debug:', {
      userId,
      isGuest,
      tier,
      hasAuthHeader: !!req.headers['authorization'],
      hasGuestHeader: !!req.headers['x-guest-id'],
      userObject: req.user
    });
    
    if (isGuest || !userId || userId === 'anonymous') {
      // For guests, return zero usage but show tier limits
      return res.json({
        used: 0,
        limit: tierConfig.maxInputSize,
        tier: 'guest',
        isGuest: true,
        percentage: 0
      });
    }
    
    // Check if Prisma is available
    if (!prisma) {
      return res.json({
        used: 0,
        limit: tierConfig.maxInputSize,
        tier: tier,
        isGuest: false,
        percentage: 0,
        requests: 0
      });
    }
    
    // Get current month usage from Supabase
    const month = monthStartISO();
    
    const usage = await prisma.usage_monthly.findUnique({
      where: {
        user_id_month: {
          user_id: userId,
          month: month
        }
      }
    });
    
    // Calculate character usage (input + output tokens converted back to chars)
    const inputChars = (usage?.input_tokens || 0) * CHARS_PER_TOKEN;
    const outputChars = (usage?.output_tokens || 0) * CHARS_PER_TOKEN;
    const totalCharsUsed = Math.round(inputChars + outputChars);
    
    const percentage = Math.min((totalCharsUsed / tierConfig.maxInputSize) * 100, 100);
    
    const result = {
      used: totalCharsUsed,
      limit: tierConfig.maxInputSize,
      tier: tier,
      isGuest: false,
      percentage: percentage,
      requests: usage?.requests || 0
    };
    
    res.json(result);
    
  } catch (error) {
    console.error('Failed to fetch current usage:', error);
    res.status(500).json({ error: 'Failed to fetch usage data', details: error.message });
  }
});

/** ------------------------- Admin: Profile Tier ------------------------- */
app.post('/admin/profile/tier', express.json(), async (req, res) => {
  try {
    const isDev = NODE_ENV !== 'production';
    const hasAdminKey = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
    if (!isDev && !hasAdminKey) return res.status(403).json({ error: 'Admin access required' });

    if (!prisma) return res.status(503).json({ error: 'DB unavailable' });
    const { userId, email, tier } = req.body || {};
    const allowed = ['free','pro','team'];
    if (!tier || !allowed.includes(String(tier).toLowerCase())) {
      return res.status(400).json({ error: `Invalid tier. One of ${allowed.join(', ')}` });
    }

    // Resolve user id
    let id = userId;
    if (!id && email) {
      // Prefer Supabase Admin API (works without direct auth.users permission)
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SRK) return res.status(500).json({ error: 'Missing Supabase service credentials' });
      const q = new URL(`${SUPABASE_URL}/auth/v1/admin/users`);
      q.searchParams.set('email', email);
      const r = await fetch(q.toString(), { headers: { 'Authorization': `Bearer ${SRK}`, 'apikey': SRK } });
      if (!r.ok) return res.status(404).json({ error: 'User not found' });
      const list = await r.json();
      const u = Array.isArray(list?.users) ? list.users[0] : Array.isArray(list) ? list[0] : list;
      if (!u?.id) return res.status(404).json({ error: 'User not found' });
      id = u.id;
    }
    if (!id) return res.status(400).json({ error: 'userId or email required' });

    await prisma.profiles.upsert({
      where: { id },
      update: { tier: tier.toLowerCase() },
      create: { id, tier: tier.toLowerCase() }
    });

    res.json({ ok:true, userId: id, tier: tier.toLowerCase() });
  } catch (e) {
    console.error('admin set tier', e);
    res.status(500).json({ error: 'Failed to set tier' });
  }
});

/** ------------------------- API: Profile ------------------------- */
app.get('/api/profile', requireAuth, ensureProfile, async (req, res) => {
  try {
    if (!prisma) return res.json({ id: req.user?.id || null, email: req.user?.email || null, tier: 'free' });
    const rows = await prisma.$queryRawUnsafe('select tier from public.profiles where id = $1 limit 1', req.user.id);
    const tier = Array.isArray(rows) && rows[0]?.tier ? String(rows[0].tier) : 'free';
    res.json({ id: req.user.id, email: req.user.email || null, tier });
  } catch (e) { console.error('profile', e?.message || e); res.status(500).json({ error: 'Failed to get profile' }); }
});
// Lightweight helper UI for setting tier (GET in browser)
app.get('/admin/profile/tier', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin: Set User Tier</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;line-height:1.5}label{display:block;margin:.5rem 0 .25rem}input,select,button{padding:.5rem .6rem;border:1px solid #ddd;border-radius:8px}button{cursor:pointer;background:#111;color:#fff}pre{background:#f7f7f7;padding:12px;border-radius:8px;white-space:pre-wrap}</style>
<h2>Admin: Set User Tier</h2>
<p>POST helper for <code>/admin/profile/tier</code>. In production you must provide your <code>x-admin-key</code>.</p>
<div>
  <label>Email (optional)</label>
  <input id="email" placeholder="user@example.com" style="min-width:320px" />
  <label>User ID (optional if email set)</label>
  <input id="userId" placeholder="auth user id (uuid)" style="min-width:320px" />
  <label>Tier</label>
  <select id="tier">
    <option value="free">free</option>
    <option value="pro">pro</option>
    <option value="team">team</option>
  </select>
  <label>Admin Key (required in production)</label>
  <input id="adminKey" placeholder="ADMIN_KEY" style="min-width:320px" />
  <div style="margin-top:12px"><button id="go">Update Tier</button></div>
  <h4>Result</h4>
  <pre id="out">(no request yet)</pre>
</div>
<script>
  document.getElementById('go').addEventListener('click', async () => {
    const email = document.getElementById('email').value.trim();
    const userId = document.getElementById('userId').value.trim();
    const tier = document.getElementById('tier').value;
    const adminKey = document.getElementById('adminKey').value.trim();
    const headers = { 'Content-Type': 'application/json' };
    if (adminKey) headers['x-admin-key'] = adminKey;
    try{
      const res = await fetch(location.pathname, { method:'POST', headers, body: JSON.stringify({ email, userId, tier }) });
      const data = await res.json();
      document.getElementById('out').textContent = JSON.stringify(data, null, 2);
    }catch(e){ document.getElementById('out').textContent = 'Error: ' + (e.message||e); }
  });
</script>`);
});

// Duplicate endpoints under /api prefix (some environments only expose /api/*)
app.post('/api/admin/profile/tier', express.json(), async (req, res) => {
  try {
    const isDev = NODE_ENV !== 'production';
    const hasAdminKey = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
    if (!isDev && !hasAdminKey) return res.status(403).json({ error: 'Admin access required' });

    if (!prisma) return res.status(503).json({ error: 'DB unavailable' });
    const { userId, email, tier } = req.body || {};
    const allowed = ['free','pro','team'];
    if (!tier || !allowed.includes(String(tier).toLowerCase())) {
      return res.status(400).json({ error: `Invalid tier. One of ${allowed.join(', ')}` });
    }
    let id = userId;
    if (!id && email) {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SRK) return res.status(500).json({ error: 'Missing Supabase service credentials' });
      const q = new URL(`${SUPABASE_URL}/auth/v1/admin/users`);
      q.searchParams.set('email', email);
      const r = await fetch(q.toString(), { headers: { 'Authorization': `Bearer ${SRK}`, 'apikey': SRK } });
      if (!r.ok) return res.status(404).json({ error: 'User not found' });
      const list = await r.json();
      const u = Array.isArray(list?.users) ? list.users[0] : Array.isArray(list) ? list[0] : list;
      if (!u?.id) return res.status(404).json({ error: 'User not found' });
      id = u.id;
    }
    if (!id) return res.status(400).json({ error: 'userId or email required' });
    await prisma.profiles.upsert({ where: { id }, update: { tier: tier.toLowerCase() }, create: { id, tier: tier.toLowerCase() } });
    res.json({ ok:true, userId: id, tier: tier.toLowerCase() });
  } catch (e) { console.error('api admin set tier', e); res.status(500).json({ error: 'Failed to set tier' }); }
});


// Add Sentry error handler (must be before other error handlers)
if (sentry) {
  app.use(sentry.Handlers.errorHandler());
}

// Add custom error handling middleware
app.use(errorHandlingMiddleware);

const server = app.listen(PORT, () => {
  // Initialize WebSocket after server starts (with error handling)
  let wsManager = null;
  try {
    if (initWebSocket && typeof initWebSocket === 'function') {
      wsManager = initWebSocket(server);
    }
  } catch (error) {
    log.warn('WebSocket initialization failed', { error: error.message });
  }
  
  log.info('Server started successfully', {
    port: PORT,
    nodeEnv: NODE_ENV,
    uploadLimit: MAX_UPLOAD_MB,
    pid: process.pid,
    m5Enabled: queueSystemInitialized,
    advancedFeaturesEnabled: advancedFeaturesInitialized
  });
  
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Environment: ${NODE_ENV}`);
  console.log(`📂 Upload limit: ${MAX_UPLOAD_MB}MB`);
  console.log(`📊 Metrics available at: http://localhost:${PORT}/metrics`);
  console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔍 Readiness check: http://localhost:${PORT}/api/health/ready`);
  
  if (queueSystemInitialized) {
    console.log(`⚡ Queue system: Enabled`);
    console.log(`🔄 Admin panel: http://localhost:${PORT}/api/admin/queues`);
  }
  
  console.log(`🛡️  Circuit breakers: Enabled`);
  console.log(`⏱️  Enhanced timeouts: Enabled`);
  
  if (advancedFeaturesInitialized) {
    console.log(`🌐 WebSocket notifications: Enabled`);
    console.log(`🔐 SSO integration: ${ssoManager.isInitialized ? 'Enabled' : 'Disabled'}`);
    console.log(`🔒 End-to-end encryption: Enabled`);
    console.log(`📋 GDPR compliance: Enabled`);
    console.log(`🕵️  Advanced audit trails: Enabled`);
    console.log(`🚀 CDN integration: ${cdnManager.config.enabled ? 'Enabled' : 'Disabled'}`);
    console.log(`⚡ Redis caching: Enabled`);
    console.log(`🧠 Translation memory: Enabled`);
  }
});

// Graceful shutdown handling for M5/M6 components
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown(signal) {
  log.info(`Received ${signal}, starting graceful shutdown...`);
  
  // Stop accepting new requests
  server.close(() => {
    log.info('HTTP server closed');
  });
  
  try {
    // Shutdown M5 components
    if (queueSystemInitialized) {
      log.info('Shutting down queue system...');
      await shutdownQueueSystem();
    }
    
    log.info('Shutting down circuit breakers...');
    await circuitBreakerService.shutdown();
    
    // Shutdown Advanced Features
    if (advancedFeaturesInitialized) {
      log.info('Shutting down advanced features...');
      await webSocketManager.shutdown?.() || Promise.resolve();
      await translationCache.shutdown?.() || Promise.resolve();
      await translationMemory.shutdown?.() || Promise.resolve();
    }
    
    // Shutdown M3 components
    log.info('Shutting down background services...');
    await backupService.shutdown?.() || Promise.resolve();
    await fileRetentionService.shutdown?.() || Promise.resolve();
    await retentionService.shutdown?.() || Promise.resolve();
    
    log.info('Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    log.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }
}
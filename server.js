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

// HTTP timeout helper (shared)
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '5000', 10);
async function fetchWithTimeout(resource, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

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
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = req.user.id;
    if (typeof req.user.id === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${req.user.id.toString().padStart(12, '0')}`;
      console.log(`ensureProfile: Converting legacy user ID ${req.user.id} to UUID format: ${userIdForDb}`);
    }
    
    await prisma.$executeRawUnsafe(
      'INSERT INTO public.profiles (id, name, tier) VALUES ($1::uuid, $2, $3) ON CONFLICT (id) DO NOTHING',
      userIdForDb, req.user.email || null, 'free'
    );
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
      // Handle legacy integer user IDs by converting to UUID format for Supabase
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }

    // Use raw SQL to avoid depending on generated model/compound unique naming
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.usage_monthly (user_id, month, requests, input_tokens, output_tokens)
       VALUES ($1::uuid, $2::date, $3::int, $4::int, $5::int)
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
    // Skip queue system in development to avoid Redis connection spam
    if (NODE_ENV === 'development') {
      console.log('⚠️  Skipping queue system initialization in development (Redis not required)');
      return;
    }
    
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
    general: `"Translate and localize the following text into {TARGET_LANG}, suitable for formal communication in official, business, or professional contexts.
Act as a {TARGET_LANG} formal-writing translator.
Style: Formal | Substyle: General | Tone: courteous and neutral | Purpose: precise, respectful communication.
Use complete sentences and formal vocabulary; avoid slang or casual phrasing.
Preserve proper nouns unless adaptation is necessary.
Render phrasing naturally in formal {TARGET_LANG} without adding or omitting meaning."\n\nText:\n{TEXT}`,
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
    academic: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is precise, polished, and authoritative for academic contexts.
Act as a professional academic translator in {TARGET_LANG}.
Style: Formal | Substyle: Academic | Purpose: Present ideas and findings clearly and objectively.
Tone: Analytical, neutral, and scholarly.
Use complete sentences with formal academic vocabulary.
Write in third person unless first person plural (“we”) is contextually required.
Apply discipline-consistent terminology.
Maintain logical flow, coherent argumentation, and clear paragraphing.
Ensure phrasing reads naturally and professionally in {TARGET_LANG} academic writing while preserving meaning and scholarly intent.
Do not carry over source sentence structures that feel unnatural."\n\nText:\n{TEXT}`,
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
    scientific: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is precise, objective, and authoritative for scientific writing.
Act as a professional scientific translator in {TARGET_LANG}.
Style: Formal | Substyle: Scientific | Purpose: Present information with clarity and rigor for academic and professional audiences.
Tone: Precise, data-driven, and impartial.
Use accurate, field-appropriate terminology.
Write in third person and maintain an impersonal, objective style.
Ensure logical flow, coherent argumentation, and factual accuracy.
Adapt phrasing and references so the output reads naturally and professionally in {TARGET_LANG} scientific writing while preserving meaning and technical accuracy.
Do not carry over source structures that sound unnatural."\n\nText:\n{TEXT}`,
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
    general: `"Translate and localize the following text into {TARGET_LANG}, making it friendly, natural, and easy to read.
Act as a professional casual translator in {TARGET_LANG}.
Style: Casual | Substyle: General | Purpose: Deliver relaxed, everyday communication.
Tone: Warm, conversational, and engaging.
Use short, clear sentences and simple vocabulary.
Include mild colloquial expressions if natural in {TARGET_LANG}.
Adapt expressions so they sound authentic to casual speech while preserving meaning.
Avoid source-language structures that feel stiff or unnatural."\n\nText:\n{TEXT}`,
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
    'social-media': `"Translate and localize the following text into {TARGET_LANG}, making it catchy, shareable, and platform-ready.
Act as a {TARGET_LANG} social media translator.
Style: Casual | Substyle: Social Media | Purpose: Drive engagement and shareability.
Tone: Playful, trendy, and friendly.
Use short, hooky lines.
Include slang, hashtags, or emojis only if natural.
Adapt trends and pop culture so it feels native to {TARGET_LANG}.
Keep it mobile-friendly and visually engaging.
Avoid stiff or overly literal phrasing."\n\nText:\n{TEXT}`,
    chat: `"Translate and localize the following text into {TARGET_LANG}, making it natural and authentic for chat conversation. Act as a {TARGET_LANG} chat translator. Output should be relaxed, concise, and relatable.
Context
Text Type: Chat Messages (SMS, WhatsApp, Messenger)
Style: Casual | Substyle: Chat | Purpose: Reflect everyday texting habits
Tone: Friendly, informal, playful
Guidelines
Use abbreviations, slang, or emojis only if natural.
Allow flexible grammar; omit subjects or shorten words like in real chats.
Adapt punctuation/spacing to {TARGET_LANG} texting style.
Keep messages short; avoid stiff or literal phrasing."\n\nText:\n{TEXT}`,
    gaming: `"Translate and localize the following text into {TARGET_LANG}, making it natural, fun, and immersive for gaming contexts. Act as a {TARGET_LANG} gaming translator. Output should feel authentic for in-game dialogue, UI, chat, or announcements.
Context
Style: Casual | Substyle: Gaming
Purpose: Engage players with authentic gaming language
Tone: Playful, energetic, sometimes competitive
Guidelines
Use gamer slang, abbreviations, humor, exaggeration, and expressive reactions.
Avoid stiff or overly formal grammar; keep chat-style formatting if natural.
Use technical jargon only when it belongs in the game world.
Adapt idioms, slang, and pop culture references so they feel native to {TARGET_LANG} gaming culture.
Preserve meaning and mood; avoid literal translations that weaken flow or fun."\n\nText:\n{TEXT}`,
    'street-talk': `"Translate and localize the following text into {TARGET_LANG}, making it bold, confident, and authentic to street culture. Act as a {TARGET_LANG} street talk translator. Output should be edgy, slang-heavy, and real.
Context
Style: Casual | Substyle: Street Talk
Purpose: Deliver the message with personality and authenticity
Tone: Cool, confident, and slang-driven
Guidelines
Use popular slang, contractions, idioms, rhythm, rhyme, or stylized spelling if natural.
Follow street speech patterns, not formal grammar; avoid polished or academic phrasing.
Keep references culturally relevant to {TARGET_LANG} urban contexts.
Match the source tone and attitude; use slang naturally, not forced.
Avoid literal translation if it weakens cultural authenticity."\n\nText:\n{TEXT}`,
    comedy: `"Translate and localize the following text into {TARGET_LANG}, making it funny, engaging, and culturally relevant. Act as a {TARGET_LANG} comedy translator with a strong sense of humor. Output should fit stand-up, memes, humorous marketing, or entertainment scripts.
Context
Style: Casual | Substyle: Comedy
Purpose: Make the audience laugh while keeping the message clear
Tone: Lighthearted, witty, playful
Guidelines
Use {TARGET_LANG} humor styles (wordplay, exaggeration, situational jokes).
Adapt punchlines to the culture; replace untranslatable humor with local equivalents.
Keep timing, phrasing, and comedic flow intact.
Avoid offensive jokes unless explicitly required.
Never do literal translations that ruin the joke."\n\nText:\n{TEXT}`,
  },

  marketing: {
    general: `"Translate and localize the following text into {TARGET_LANG}, making it persuasive, benefit-driven, and culturally engaging. Act as a {TARGET_LANG} marketing translator with expertise in consumer behavior. Output should promote a product, service, or idea clearly and effectively.
Context
Style: Marketing | Substyle: General
Purpose: Persuade and engage target audience
Tone: Positive, persuasive, and clear
Guidelines
Highlight key benefits and natural calls-to-action
Adapt cultural references for relevance
Keep flow smooth; avoid technical or stiff phrasing
Avoid literal translation that weakens persuasion"\n\nText:\n{TEXT}`,
    promotional: `"Translate and localize the following text into {TARGET_LANG}, making it persuasive, engaging, and compelling. Act as a {TARGET_LANG} marketing translator with expertise in promotional content. Output should be clear, attractive, and drive action.
Context
Style: Marketing | Substyle: Promotional
Purpose: Promote a product, service, or offer effectively
Tone: Exciting, persuasive, audience-focused
Guidelines
Use short, impactful sentences with promotional keywords and emotional triggers
Highlight benefits and value clearly
Include persuasive calls-to-action suited to {TARGET_LANG} culture
Maintain smooth marketing flow; avoid literal translations that weaken impact"\n\nText:\n{TEXT}`,
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
    persuasive: `"Translate and localize the following text into {TARGET_LANG}, making it persuasive, trustworthy, and motivating. Act as a {TARGET_LANG} marketing translator with expertise in pitches and persuasive copy. Output should be clear, confident, and emotionally engaging.
Context
Style: Marketing | Substyle: Pitching
Purpose: Convince the audience to accept, invest, or act
Tone: Professional, persuasive, trust-building
Guidelines
Maintain logical flow (problem → solution → call to action)
Highlight benefits over features
Adapt emotional triggers to {TARGET_LANG}
Balance emotion with credibility; avoid over-promises
Ensure smooth, spoken-like readability"\n\nText:\n{TEXT}`,
    descriptive: `"Translate and localize the following text into {TARGET_LANG}, making it persuasive, trustworthy, and motivating. Act as a {TARGET_LANG} marketing translator with expertise in pitches and persuasive copy. Output should be clear, confident, and emotionally engaging.
Context
Style: Marketing | Substyle: Pitching
Purpose: Convince the audience to accept, invest, or act
Tone: Professional, persuasive, trust-building
Guidelines
Maintain logical flow (problem → solution → call to action)
Highlight benefits over features
Adapt emotional triggers to {TARGET_LANG}
Balance emotion with credibility; avoid over-promises
Ensure smooth, spoken-like readability"\n\nText:\n{TEXT}`,
    'brand-storytelling': `"Translate and localize the following text into {TARGET_LANG}, ensuring it tells the brand’s journey in a compelling and relatable way. Act as a {TARGET_LANG} brand storyteller. Produce output that is authentic, emotional, and trust-building.
Context
Style: Marketing | Substyle: Brand Storytelling
Purpose: Build an emotional connection with the audience
Tone: Warm, authentic, inspiring
Guidelines
Use narrative, flowing sentences
Include relatable references when natural
Follow official grammar and spelling standards while allowing creative storytelling flow
Preserve the brand’s core message and emotional arc
Adapt cultural touchpoints to resonate with {TARGET_LANG} audiences
Avoid literal phrasing that feels cold or corporate"\n\nText:\n{TEXT}`,
    'seo-friendly': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is optimized for relevant search terms while preserving meaning. Act as a {TARGET_LANG} SEO content translator. Produce output that is keyword-optimized, natural, and persuasive.
Context
Style: Marketing | Substyle: SEO-Friendly
Purpose: Improve search visibility and drive conversions
Tone: Clear, relevant, and conversion-focused
Guidelines
Integrate {TARGET_LANG} keywords naturally, not forced
Keep sentences concise, readable, and engaging
Follow official grammar and spelling standards while maintaining SEO structure
Preserve persuasive and conversion-oriented language"\n\nText:\n{TEXT}`,
    'social-media-marketing': `"Translate and localize the following text into {TARGET_LANG}, making it engaging, shareable, and platform-ready. Act as a {TARGET_LANG} social media translator. Output should be fun, catchy, and audience-relevant.
Guidelines
Use short, hooky lines
Add hashtags/trends only if natural
Keep sentences mobile-friendly
Allow informal tone while following official grammar
Adapt to platform norms (IG, TikTok, X, YouTube)
Avoid literal translation that weakens social tone"\n\nText:\n{TEXT}`,
    'email-campaigns': `"Translate and localize the following text into {TARGET_LANG}, making it engaging, persuasive, and conversion-focused for email campaigns. Act as a {TARGET_LANG} email marketing translator. Produce copy that is clear, skimmable, and optimized for opens, clicks, and conversions.
Guidelines
Strong subject & preheader
Concise body with short paragraphs/bullets
Clear, compelling CTAs
Conversational tone where natural; follow official grammar/spelling
Avoid spammy patterns (ALL CAPS, !!!, bait)
Adapt dates, currency, and references to {TARGET_LANG} norms
Preserve structure (subject, preheader, body, CTA), links, offers, and legal lines
Highlight benefits and value clearly
Keep mobile-friendly length
Avoid literal phrasing that reduces impact"\n\nText:\n{TEXT}`,
    'event-promotion': `"Translate and localize the following text into {TARGET_LANG}, making it exciting, persuasive, and motivating for event attendance. Act as a {TARGET_LANG} event marketing translator. Deliver copy that is clear, energetic, and audience-focused.
Guidelines
Use action-oriented, engaging sentences
Clearly state dates, locations, and calls-to-action
Highlight key benefits of attending
Adapt cultural references for local resonance
Keep language concise, persuasive, and professional
Follow official grammar and spelling standards"\n\nText:\n{TEXT}`,
    'influencer-ugc-style': `"Translate and localize the following text into {TARGET_LANG}, making it authentic, personal, and conversational. Act as a {TARGET_LANG} influencer content translator. Deliver copy that is natural, first-person, and relatable.
Guidelines
Use first-person voice (“I” statements: I love, I tried, I recommend)
Keep tone friendly, enthusiastic, and personal
Ensure voice feels genuine and trustworthy
Adapt product/cultural references for local familiarity
Maintain casual, relatable flow while following grammar and spelling standards"\n\nText:\n{TEXT}`,
  },

  dubbing: {
    general: `"Translate and localize the following text into {TARGET_LANG}, ensuring it flows naturally for dubbing. Act as a {TARGET_LANG} dubbing translator. Deliver lines that are smooth, clear, and performance-ready.
Guidelines
Context-based: Consider scene, speaker–listener relations, and avoid literal mapping.
Kinship/titles: Translate accurately (e.g., “Bu” → Mom vs. Ma’am) and keep consistent within scenes.
Split-lines: If a sentence spans multiple lines, keep the split but translate continuously.
Timing: Match rhythm and syllable count; don’t add length unless clarity requires it.
Onomatopoeia: Adapt sound effects and expressive sounds to natural {TARGET_LANG} forms.
Character voice: Preserve personality, tone, slang, idioms; adapt humor culturally.
Delivery: Keep lines smooth, lip-sync feasible, and ready for performance."\n\nText:\n{TEXT}`,
    dialogue: `"Translate and localize the following text into {TARGET_LANG}, ensuring it matches natural speech and is easy to perform by voice actors. Act as a {TARGET_LANG} dubbing translator. Deliver output that is smooth, clear, and performance-ready.
Guidelines
Context-based: Consider scene, relationships, and setting; avoid literal mapping.
Honorifics/kinship: Translate accurately (e.g., “Bu” → Mom vs. Ma’am) and stay consistent.
Split-lines: If one sentence spans multiple lines, keep the split but translate continuously.
Timing: Match pacing and syllable count; avoid extra length unless clarity requires it.
Onomatopoeia: Adapt sound effects naturally and vividly in {TARGET_LANG}.
Character voice: Preserve tone, slang, idioms, and personality; adapt humor culturally.
Delivery: Keep lines lip-sync feasible, clear, and natural for spoken performance."\n\nText:\n{TEXT}`,
    narrative: `"Translate and localize the following text into {TARGET_LANG}, ensuring it flows naturally when spoken aloud.
Act as a {TARGET_LANG} dubbing translator for narration. Produce output that is smooth, clear, and performance-ready.
Guidelines
Spoken-friendly {TARGET_LANG}, natural rhythm, avoid long/complex sentences.
Adapt vocabulary to audience (general, historical, children).
Onomatopoeia: translate/adapt sound effects naturally and vividly.
Context-based: consider scene, audience, and setting.
Honorifics/kinship: translate correctly (e.g., “Bu” → Mom vs. Ma’am).
Split-lines: keep splits but translate continuously.
Timing: match pacing and syllable count; avoid unnecessary length.
Tone/voice: preserve narrative voice and adjust (serious, formal, playful) as needed.
Delivery: ensure clarity, smooth oral flow, and natural performance."\n\nText:\n{TEXT}`,
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
    general: `"Translate and localize the following text into {TARGET_LANG}, preserving emotional impact and creative expression. Act as a {TARGET_LANG} creative-literary translator. Deliver engaging, imaginative, culturally resonant copy.
Guidelines:
Creative writing or artistic content.
Rich yet natural diction; varied sentence structures.
Follow official grammar and spelling; allow tasteful artistic license.
Adapt onomatopoeia to sound natural and expressive in {TARGET_LANG}.
Keep tone, imagery, and narrative flow intact; respect cultural nuance.
Avoid stiff or overly literal phrasing."\n\nText:\n{TEXT}`,
    'literary-adaptation': `"Translate and localize the following text into {TARGET_LANG}, preserving meaning, emotion, imagery, and literary style so it reads naturally to {TARGET_LANG} readers. Act as a {TARGET_LANG} literary translator for narrative prose.
Guidelines
Text type: novel / short story / literary passage.
Use rich but unforced diction; preserve metaphor, symbolism, rhythm, and voice.
Keep tone, narrative flow, and structure intact.
Adapt idioms, cultural references, and wordplay for natural resonance in {TARGET_LANG}.
Avoid calques or literal phrasing that weakens the literary feel."\n\nText:\n{TEXT}`,
    'slogan-tagline-writing': `"Translate and localize the following text into {TARGET_LANG} as a slogan/tagline that is catchy, memorable, and impactful. Act as a {TARGET_LANG} creative copywriter for branding. Deliver punchy, brand-aligned copy.
Guidelines:
Keep it short and culturally natural.
Use wordplay/rhyme/rhythm when helpful.
Follow official grammar/spelling; intentional breaks allowed for memorability.
Preserve the core brand message and emotional pull.
Aim for the briefest version that retains impact."\n\nText:\n{TEXT}`,
    'poetic-tone': `"Translate and localize the following text into {TARGET_LANG} for narrative prose, capturing flow, pacing, emotional beats, and distinct character voices. Act as a {TARGET_LANG} narrative-prose translator. Deliver immersive, natural copy suitable for novels, short stories, or narrative passages.
Guidelines
Use descriptive yet accessible language.
Preserve the narrative arc and tone shifts; keep character voices intact.
Adapt names, idioms, and cultural references naturally.
Avoid flat or literal phrasing; maintain immersion.
Make it read as if originally written in {TARGET_LANG}; follow official grammar and spelling."\n\nText:\n{TEXT}`,
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
    general: `"Translate and localize the following text into {TARGET_LANG} for a general technical audience. Act as a {TARGET_LANG} technical documentation translator. Deliver clear, concise, technically accurate copy.
Guidelines:
Use standardized {TARGET_LANG} terminology; keep facts, units, and data exact.
Write unambiguous, step-by-step instructions where useful.
Maintain a clear, direct, neutral tone.
Avoid literal carryover that harms clarity; make it read naturally to technical readers."\n\nText:\n{TEXT}`,
    'software-documentation': `"Translate and localize the following text into {TARGET_LANG} for software documentation. Act as a {TARGET_LANG} software-docs translator. Produce precise, consistent, user-friendly copy for developers and end users.
Guidelines
Preserve technical meaning and step order; keep existing structure (headings/lists/steps).
Use standard {TARGET_LANG} technical terms; retain established English terms when industry-standard.
Keep code, commands, UI labels, file paths, placeholders, and URLs unchanged.
Be clear and concise; avoid literal carryover that hurts readability or accuracy."\n\nText:\n{TEXT}`,
    'engineering-manuals': `"Translate and localize the following text into {TARGET_LANG} for an engineering manual. Act as a {TARGET_LANG} engineering-manual translator. Deliver clear, precise, standard-compliant instructions for engineers and technicians.
Guidelines
Preserve technical accuracy and step order; keep structure (headings, lists, tables) intact.
Use industry-approved {TARGET_LANG} terms; retain established English terms when standard.
Keep numbers, specs, tolerances, part names, model codes, warnings, and symbols exact.
Adapt units, formats, and referenced standards to local requirements; include originals if needed.
Write formally and unambiguously; avoid casual or vague phrasing.
Ensure sequential, easy-to-follow procedures."\n\nText:\n{TEXT}`,
    'product-specs': `"Translate and localize the following text into {TARGET_LANG} for a product specification/datasheet. Act as a {TARGET_LANG} product-spec translator. Deliver exact, structured, standards-compliant copy.
Guidelines
Preserve all technical details: values, tolerances, dimensions, units, part and model codes, standards, warnings, symbols.
Keep structure intact: headings, bullets, tables, field labels.
Use correct {TARGET_LANG} terminology; retain established English terms when industry standard.
Convert units and numeric formats to local norms when required; include originals if needed.
Ensure term, unit, and abbreviation consistency across the document.
Write in a precise, factual, objective tone; avoid marketing language.
Return only the localized specifications."\n\nText:\n{TEXT}`,
    'api-guides': `"Translate and localize the following text into {TARGET_LANG} for an API guide/reference. Act as a {TARGET_LANG} API-docs translator. Produce clear, precise, developer-friendly copy.
Guidelines
Do not change code: code blocks, inline code, endpoints/paths, placeholders (e.g., {id}), params/fields, HTTP methods/status codes, payload keys, JSON examples, CLI commands, file names/paths, versions.
Translate only prose: headings, body text, notes, comments, and table cells that aren’t code.
Preserve formatting: markdown structure, lists, tables, code fences/backticks.
Use standard {TARGET_LANG} terminology; keep established English tech terms (API, SDK, JSON, OAuth, webhook) as is.
Keep terminology consistent; do not add, omit, or reinterpret content."\n\nText:\n{TEXT}`,
  },

  legal: {
    general: `"Translate and localize the following text into {TARGET_LANG} for a general legal document. Act as a {TARGET_LANG} legal translator. Produce formal, precise, unambiguous copy aligned with {TARGET_LANG} drafting norms.
Guidelines
Preserve legal effect; no additions or omissions.
Use standard {TARGET_LANG} legal terminology; avoid colloquial or vague wording.
Keep defined terms, capitalization, references, numbering, clauses, and structure intact.
Maintain official grammar/spelling.
Prefer natural legal phrasing over literal mappings that could create ambiguity.
If the content concerns tax or transfer pricing, apply OECD-aligned terminology and map local paraphrases to recognized TP terms in {TARGET_LANG} (e.g., “prinsip kewajaran dan kelaziman usaha” → “arm's length principle”). Keep method names and acronyms consistent (CUP, RPM, CPM, TNMM, PSM, APA, MAP)."\n\nText:\n{TEXT}`,
    contracts: `"Translate and localize the following text into {TARGET_LANG}, for a contract/agreement. Act as a {TARGET_LANG} contract-law translator. Deliver formal, precise, enforceable copy aligned with local drafting conventions.
Guidelines
Preserve legal effect; no additions or omissions.
Use standard {TARGET_LANG} contract terminology; avoid colloquial or vague wording.
Keep formatting intact: headings, clause/section numbering, defined terms, references.
Follow official grammar, spelling, and legal formatting norms.
Prefer natural legal phrasing over literal wording that could create ambiguity."\n\nText:\n{TEXT}`,
    'terms-conditions': `"Translate and localize the following text into {TARGET_LANG}, as Terms & Conditions compliant with {TARGET_LANG} law. Act as a {TARGET_LANG} legal translator (consumer/digital). Deliver formal, clear, enforceable T&C.
Guidelines
Preserve all rights, disclaimers, and limitations; no additions or omissions.
Use standard legal/business terminology; avoid vagueness and overly complex sentences.
Keep structure and formatting: headings, clause numbering, defined terms.
Follow official grammar, spelling, and legal formatting in {TARGET_LANG}.
Prefer precise, natural legal phrasing over literal wording that could create loopholes."\n\nText:\n{TEXT}`,
    'compliance-docs': `"Translate and localize the following text into {TARGET_LANG}, preserving legal and regulatory meaning and aligning with {TARGET_LANG} compliance standards. Act as a {TARGET_LANG} legal translator specialized in regulatory compliance. Deliver accurate, compliant, audit-ready text.
Guidelines
Use standardized compliance terminology and official grammar/spelling; follow industry document formatting.
Keep structure intact: headings, numbering, tables, defined terms.
Adapt references, dates, units, and citations to {TARGET_LANG} laws and standards.
Ensure precision for legal/regulatory review; avoid ambiguity and casual phrasing.
Prefer clear, natural legal wording over literal phrasing that could misrepresent requirements."\n\nText:\n{TEXT}`,
    'privacy-policies': `"Translate and localize the following text into {TARGET_LANG}, ensuring compliance with {TARGET_LANG} privacy and data protection laws. Act as a {TARGET_LANG} legal translator specializing in data protection. Deliver a clear, accurate, legally enforceable privacy policy.
Guidelines
Use formal legal and privacy terminology; follow applicable standards and official grammar and spelling.
Keep structure intact: headings, sections, clause numbering, defined terms.
Clearly explain user rights and how personal data is collected, used, shared, and retained.
Preserve all rights and obligations; do not add or omit content.
Ensure layperson clarity; avoid vague or overly broad statements.
Avoid literal phrasing that could conflict with regulations; adapt dates, numbers, and references to {TARGET_LANG} norms."\n\nText:\n{TEXT}`,
    constitutional: `"Translate and localize the following text into {TARGET_LANG}, preserving legal authority and the formal constitutional register. Act as a {TARGET_LANG} constitutional-law translator. Deliver text that is precise, binding, and historically respectful.
Guidelines
Use official constitutional/legal vocabulary and legislative drafting conventions; follow official grammar/spelling.
Keep meaning exact: add nothing, omit nothing; avoid paraphrasing that changes legal effect.
Maintain original numbering, headings, clauses, definitions, and citations.
Preserve historical and cultural references faithfully.
Maintain an extremely formal, authoritative tone.
Adapt dates and citation formats to {TARGET_LANG} standards without altering substance."\n\nText:\n{TEXT}`,
  },

  medical: {
    general: `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, accurate, and suitable for a general medical context. Act as a {TARGET_LANG} medical translator. Deliver professional, easy-to-understand copy.
Guidelines
Preserve meaning exactly.
Use standard medical terminology; briefly explain complex terms if needed.
Keep tone neutral and factual; avoid jargon-heavy or oversimplified wording.
Follow official {TARGET_LANG} grammar and spelling; ensure natural professional flow."\n\nText:\n{TEXT}`,
    'patient-friendly-explanation': `"Translate and localize the following text into {TARGET_LANG}, making it clear, simple, and reassuring for patients. Act as a {TARGET_LANG} medical translator. Deliver accurate, culturally sensitive patient-facing copy.
Guidelines
Preserve meaning exactly (no additions or omissions).
Use everyday language; briefly explain medical terms when needed.
Keep tone calm, empathetic, and supportive.
Write short, clear sentences for readability.
Follow official {TARGET_LANG} grammar and spelling; avoid literal phrasing that sounds overly technical."\n\nText:\n{TEXT}`,
    'research-abstracts': `"Translate and localize the following text into {TARGET_LANG}, preserving scientific accuracy and an academic tone. Act as a {TARGET_LANG} medical-research translator. Deliver precise, formal, journal-ready output.
Guidelines
Keep all data, terminology, headings, and structure (no additions or omissions).
Use standardized medical/scientific terms; follow {TARGET_LANG} academic conventions and official grammar/spelling.
Maintain a formal, technical, objective, and concise style.
Do not oversimplify; keep professional rigor.
Avoid literal phrasing that distorts meaning."\n\nText:\n{TEXT}`,
    'clinical-documentation': `"Translate and localize the following text into {TARGET_LANG} for clinical documentation, with full medical accuracy and compliance with {TARGET_LANG} healthcare standards. Act as a {TARGET_LANG} clinical records translator. Deliver formal, exact, objective, file-ready text.
Guidelines
Text types: clinical notes, patient records, medical reports
Preserve structure, headings, and numbering; no additions or omissions
Use standardized medical terminology; follow official grammar/spelling and clinical norms
Keep a factual tone; avoid interpretation or explanations
Avoid unnecessary rewording; prioritize precision"\n\nText:\n{TEXT}`,
    'health-campaigns': `"Translate and localize the following text into {TARGET_LANG}, for public health campaigns (clear, motivating, culturally relevant). Act as a {TARGET_LANG} public health communicator. Deliver concise, empathetic, persuasive copy.
Guidelines
Text type: awareness material
Preserve core facts and intent; no additions or omissions
Use friendly, accessible wording; briefly clarify essential terms
Adapt examples and idioms to {TARGET_LANG} context
Avoid literal or stiff phrasing; keep tone positive and engaging"\n\nText:\n{TEXT}`,
  },

  journalistic: {
    general: `"Translate and localize the following text into {TARGET_LANG}, so it reads like a native news article (neutral, factual, concise). Act as a {TARGET_LANG} news translator. Follow newsroom norms.
Guidelines
Text type: general news
Use inverted pyramid or clear logical structure
Keep quotes and attributions intact
Localize references, dates, and formats where appropriate
Ensure accuracy and verifiability; preserve names and figures
Natural phrasing over literal calques; clear, concise sentences; standard grammar and spelling"\n\nText:\n{TEXT}`,
    'news-reports': `"Translate and localize the following text into {TARGET_LANG}, formatted as a professional news report. Act as a {TARGET_LANG} newsroom translator. Produce neutral, factual, fluent copy.
Guidelines
Use news structure (inverted pyramid or clear logic).
Keep facts, names, figures, quotes, and attributions intact.
Localize dates, units, titles, and references appropriately.
Write clear, concise sentences with standard grammar and spelling.
Prefer natural phrasing over literal calques; avoid source-like sentence patterns."\n\nText:\n{TEXT}`,
    'editorial-opinion': `"Translate and localize the following text into {TARGET_LANG}, as a journalistic editorial/opinion piece. Act as a {TARGET_LANG} editorial translator. Deliver persuasive, coherent copy that fits opinion-page conventions.
Guidelines
Use formal or semi-formal register as appropriate.
Preserve the author’s stance, argument, and supporting points.
Ensure clear logic and flow between paragraphs.
Adapt cultural references for {TARGET_LANG} readers.
Use standard grammar and spelling.
Prefer natural phrasing over literal translation that weakens persuasion."\n\nText:\n{TEXT}`,
    'feature-articles': `"Translate and localize the following text into {TARGET_LANG}, in engaging, descriptive feature-article style. Act as a {TARGET_LANG} feature-writing translator. Deliver informative, vivid, audience-focused copy.
Guidelines
Use rich yet clear vocabulary and varied sentence lengths.
Weave in descriptive details and human-interest angles.
Preserve depth, structure, and narrative flow.
Adapt metaphors, idioms, and cultural references to feel native in {TARGET_LANG}.
Keep facts accurate; use standard grammar and spelling.
Prefer natural phrasing over literal translation."\n\nText:\n{TEXT}`,
    'press-releases': `"Translate and localize the following text into {TARGET_LANG} as a clear, factual, publication-ready press release. Act as a {TARGET_LANG} PR translator. Deliver professional, concise copy.
Guidelines
Use a direct tone and short, clean sentences.
Keep all facts, names, figures, links intact.
Apply standard press-release structure and {TARGET_LANG} grammar/spelling.
Adapt dates, times, numbers, and currency to {TARGET_LANG} norms.
Avoid excessive jargon; prefer natural phrasing over literal translation."\n\nText:\n{TEXT}`,
  },

  corporate: {
    general: `"Translate and localize the following text into {TARGET_LANG} for corporate communication (clear, professional, brand-aligned). Act as a {TARGET_LANG} corporate translator. Deliver concise, polished, company-voice copy.
Guidelines
Preserve meaning and structure; use professional vocabulary.
Follow official grammar/spelling and any provided tone-of-voice.
Avoid unnecessary jargon; use natural corporate phrasing.
Make it feel native to {TARGET_LANG} business culture."\n\nText:\n{TEXT}`,
    'internal-communications': `"Translate and localize the following text into {TARGET_LANG} for internal corporate communications (clear, respectful, company-aligned). Act as a {TARGET_LANG} workplace communications translator. Deliver professional, approachable copy.
Guidelines
Preserve intent and structure (headings/bullets if present).
Use concise, scannable sentences; avoid unnecessary jargon.
Align with company voice and values.
Adapt references to {TARGET_LANG} workplace context.
Avoid literal phrasing that reads stiff; make it feel native to employees."\n\nText:\n{TEXT}`,
    'investor-relations': `"Translate and localize the following text into {TARGET_LANG} for investor relations (accurate, professional, compliant). Act as a {TARGET_LANG} financial communications translator. Deliver precise, formal, credible copy.
Guidelines
Preserve all numbers, dates, units, metrics, footnotes, and disclosures.
Use standard {TARGET_LANG} financial/accounting terminology; follow IR reporting norms.
Maintain a formal, authoritative, transparent tone.
Be clear and unambiguous; avoid hype or vague phrasing.
Keep structure and formatting (headings, bullets, tables).
Adapt currency, number styles, and terms to {TARGET_LANG} conventions.
No additions or omissions."\n\nText:\n{TEXT}`,
    'annual-reports': `"Translate and localize the following text into {TARGET_LANG} for annual reports (professional, accurate, publication-ready). Act as a {TARGET_LANG} corporate and financial translator. Deliver clear, formal, compliant copy.
Guidelines
Preserve all data, figures, dates, tables, captions, and footnotes.
Use standard {TARGET_LANG} corporate and accounting terminology; follow reporting norms.
Keep original structure and headings; maintain a confident, factual tone.
Adapt currency, number styles, units, and date formats to {TARGET_LANG} conventions.
Be precise and objective; avoid embellishment.
No additions or omissions."\n\nText:\n{TEXT}`,
    'professional-presentations': `"Translate and localize the following text into {TARGET_LANG} for corporate presentations (clear, professional, engaging). Act as a {TARGET_LANG} business presentation translator. Deliver concise, impactful copy for slides, scripts, and pitches.
Guidelines
Use short, punchy lines and bullet-friendly phrasing.
Follow official {TARGET_LANG} grammar, spelling, and business norms.
Preserve structure and logical flow; keep headings and key terms consistent.
Use standard {TARGET_LANG} business terminology.
Maintain a formal, confident, engaging tone.
Avoid long or complex sentences."\n\nText:\n{TEXT}`,
  },

  entertainment: {
    general: `"Translate and localize the following text into {TARGET_LANG} for general entertainment (engaging, relatable, audience friendly). Act as a {TARGET_LANG} entertainment translator with pop-culture expertise. Deliver fun, dynamic copy that feels native.
Guidelines
Use conversational flow and lively vocabulary.
Adapt idioms, jokes, and cultural references to {TARGET_LANG}.
Keep the tone energetic and inviting.
Follow official grammar and spelling; allow natural creativity.
Avoid literal or stiff phrasing that reduces entertainment value."\n\nText:\n{TEXT}`,
    subtitling: `"Translate and localize the following text into {TARGET_LANG} as entertainment subtitles (clear, concise, engaging). Act as a {TARGET_LANG} AV subtitle translator. Produce accurate, natural lines timed for easy reading.
Guidelines
Keep lines short to meet reading-speed norms.
Match the scene’s tone; maintain natural spoken flow.
Adapt idioms, jokes, and slang to {TARGET_LANG}.
Use official grammar and spelling.
Avoid literal or stiff phrasing that hurts readability."\n\nText:\n{TEXT}`,
    screenwriting: `"Translate and localize the following text into {TARGET_LANG}, making it production-ready for film/TV. Act as a {TARGET_LANG} screenwriter-translator. Deliver natural, dramatic dialogue that works for local actors and audiences.
Guidelines
Keep spoken-friendly lines and preserve screenplay formatting (character names, parentheticals, action).
Match the scene’s tone (drama, comedy, romance, suspense).
Preserve character voice and intent.
Adapt humor, idioms, and cultural references to {TARGET_LANG} equivalents.
Keep pacing performable; avoid stiff or literal phrasing that hurts flow."\n\nText:\n{TEXT}`,
    'script-adaptation': `"Translate and localize the following text into {TARGET_LANG}, for a culturally authentic script adaptation. Act as a {TARGET_LANG} script adapter. Deliver engaging, natural lines for film/TV/web/theatre.
Guidelines
Keep plot, tone, pacing, and character voice.
Preserve script formatting (character names, parentheticals, action).
Use audience-friendly phrasing; adapt humor, idioms, and references to {TARGET_LANG} equivalents.
Replace untranslatable items with culturally relevant ones.
Ensure smooth, performable dialogue; avoid stiff or overly literal phrasing."\n\nText:\n{TEXT}`,
    'character-dialogue': `"Translate and localize the following text into {TARGET_LANG}, staying true to each character’s voice and the scene’s mood. Act as a {TARGET_LANG} character-dialogue translator. Deliver natural, performable lines.
Guidelines
Preserve character voice, intent, relationships, and emotional beats.
Use spoken {TARGET_LANG} suited to age/role; keep delivery concise and believable.
Localize slang, humor, idioms, and cultural cues; prefer native equivalents over literal.
Avoid stiff or word-for-word phrasing; make it read like original {TARGET_LANG} dialogue."\n\nText:\n{TEXT}`,
  },

  educational: {
    general: `"Translate and localize the following text into {TARGET_LANG}, keeping it instructionally clear for {TARGET_LANG} learners. Act as a {TARGET_LANG} educational translator. Deliver clear, supportive, easy-to-follow content.
Guidelines
Use plain {TARGET_LANG} and short sentences.
Present steps logically; use numbering/bullets when helpful.
Follow official grammar and spelling standards.
Preserve factual/process accuracy; avoid unnecessary jargon (briefly explain if needed).
Maintain a supportive, motivating tone."\n\nText:\n{TEXT}`,
    'e-learning': `"Translate and localize the following text into {TARGET_LANG} for e-learning (clear, engaging, platform-ready). Act as a {TARGET_LANG} e-learning translator. Produce motivating, learner-friendly copy.
Guidelines
Use plain {TARGET_LANG} and short, digestible sentences.
Structure for screens: headings, bullets, and steps.
Follow official grammar and spelling standards.
Keep an encouraging, interactive tone.
Minimize jargon; briefly explain terms when needed.
Localize examples and references for {TARGET_LANG} learners.
Preserve accuracy and intent."\n\nText:\n{TEXT}`,
    'step-by-step-guides': `"Translate and localize the following text into {TARGET_LANG} as a step-by-step guide (clear, sequential, easy to follow). Act as a {TARGET_LANG} instructional translator. Deliver accurate, concise, user-friendly instructions.
Guidelines
Use numbered steps or bullets where helpful.
Use plain {TARGET_LANG} and short sentences.
Follow official grammar and spelling standards.
Keep the original step order.
Prefer direct, actionable phrasing; avoid unnecessary complexity.
Use standard {TARGET_LANG} terminology; adapt terms naturally."\n\nText:\n{TEXT}`,
    'academic-tutorials': `"Translate and localize the following text into {TARGET_LANG}, ensuring clarity, accuracy, and alignment with {TARGET_LANG} academic conventions. Act as a {TARGET_LANG} academic translator. Produce structured, precise, easy-to-follow tutorial text.
Guidelines
Use correct discipline terminology.
Keep a formal yet approachable, educational tone.
Maintain clear logical structure and flow.
Follow official grammar and spelling standards.
Adapt examples or references for {TARGET_LANG} learners when helpful.
Avoid literal carry-over that disrupts academic style."\n\nText:\n{TEXT}`,
    'test-preparation': `"Translate and localize the following text into {TARGET_LANG}, ensuring it is clear, accurate, and motivating for learners. Act as a {TARGET_LANG} exam-prep translator. Deliver student-focused, encouraging, precise output.
Context: Education > Test Preparation (practice questions, study tips, exam strategies).
Guidelines
Use straightforward {TARGET_LANG}; follow official grammar/spelling.
Keep instructions and examples clear and direct.
Maintain a supportive, structured tone.
Adapt terminology to {TARGET_LANG} education standards; keep content relevant.
Balance clarity with engagement; avoid overly complex phrasing."\n\nText:\n{TEXT}`,
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
Formatting defaults (override if mode/template requires structure):
- Avoid em dashes (—) and en dashes (–) as punctuation by default.
- Avoid " - " as a separator and avoid bullet lists by default.
- Use commas or periods instead when lists are not required.
- Keep hyphens only inside words where linguistically required (e.g., co-founder, anak-anak).
- Prefer plain paragraphs unless the prompt/mode explicitly requires lists, headings, tables, code blocks, or multi-speaker dashes.
- If any rule here conflicts with mode-specific instructions or overrides, the mode-specific instructions take precedence.
`;

/** Global subtitle/dubbing overrides (applies on top of the per-mode templates) */
const SUBTITLE_OVERRIDES = `
GLOBAL SUBTITLE/DUBBING RULES:
- These subtitle/dubbing rules override paragraph/list/dash constraints in the global style guard.
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
 - DIALOGUE DASHES (MULTI-SPEAKER IN ONE CUE):
   If the source cue contains multiple lines starting with a dash (e.g., "- Let me go!\n- No, no, no."), you MUST return the SAME number of lines, each starting with a dash, preserving line breaks and dash markers.
   Example:
   SOURCE:
   - Sicher, sicher, was auch immer.\n- Okay.
   TARGET (English):
   - Sure, sure, whatever.\n- Okay.
   Do NOT merge them into one line. Keep 1:1 line mapping with leading dashes.
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

  // SAFETY NET: Preserve multi-speaker dash lines 1:1 when source uses "- " per line
  try {
    const srcLinesAll = String(srcText || '').split(/\r?\n/);
    const srcDashCount = srcLinesAll.filter(l => l.trim().startsWith('-')).length;
    if (srcDashCount >= 2) {
      const tgtLinesRaw = String(out).split(/\r?\n/);
      const ensureDash = (s) => {
        const t = String(s || '').trim();
        return t ? (t.startsWith('-') ? t : ('- ' + t)) : t;
      };
      let tgtDashCount = tgtLinesRaw.filter(l => l.trim().startsWith('-')).length;
      if (tgtDashCount !== srcDashCount) {
        // Try splitting into sentences first
        const parts = String(out)
          .split(/(?<=[.!?…]["'”’)?\]]*)\s+/)
          .map(s => s.trim())
          .filter(Boolean);
        if (parts.length === srcDashCount) {
          out = parts.map(ensureDash).join('\n');
        } else if (tgtLinesRaw.length === srcDashCount) {
          out = tgtLinesRaw.map(ensureDash).join('\n');
        } else {
          // fallback: split on " - " if present or pad lines
          const hy = String(out).split(/\s-\s/).map(s=>s.trim()).filter(Boolean);
          if (hy.length === srcDashCount) out = hy.map(ensureDash).join('\n');
          else {
            const base = ensureDash(out);
            const arr = new Array(srcDashCount).fill('');
            arr[0] = base;
            out = arr.join('\n');
          }
        }
      } else {
        out = tgtLinesRaw.map(ensureDash).join('\n');
      }
    }
  } catch {}

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
- Structure: Preserve lists, headings, tables, and code blocks when the prompt/mode requires them; otherwise prefer plain paragraphs.
- Output must be returned ONLY between <result> and </result>.
`;

  const REPHRASE_QA_BLOCK = `
QUALITY CHECK BEFORE RETURN:
- Language preservation: Keep the EXACT same language as the input - DO NOT translate to any other language.
- Context preservation: Maintain the emotional tone, context, and implied meaning of the original.
- Style adaptation: Apply the requested style and substyle while keeping the same language.
- Punctuation preservation: Keep the same punctuation type from source (? stays ?, . stays ., ! stays !, ... stays ...).
- Terminology consistency: keep domain terms consistent within the output.
- Structure: Preserve lists, headings, tables, and code blocks when the prompt/mode requires them; otherwise prefer plain paragraphs.
- Output must be returned ONLY between <result> and </result>.
`;

  const injBlock = renderInjections(injections);

  if (rephrase || !targetLanguage) {
    // ✅ Strong rephrase-only template (never translate or code-switch)
    const REPHRASE_TEMPLATE = `Rephrase the following text in the EXACT SAME LANGUAGE as the input. Do NOT translate or change language. Do NOT code-switch. Preserve meaning, domain terms, and proper nouns; adjust tone/style to the requested style/substyle.\n\nStyle: ${modeKey || 'general'} | Substyle: ${subKey || 'general'}\n\nText:\n{TEXT}`;

    const renderedTmpl = safeRenderTemplate(REPHRASE_TEMPLATE, {
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
  
  // Try API key first, then JWT auth, but allow unauthenticated as guest
  if (req.headers['x-api-key']) {
    return requireApiKey(req, res, next);
  } else if (req.headers['authorization']) {
    return requireAuth(req, res, next);
  } else {
    // No authentication provided - treat as anonymous guest
    req.user = {
      id: 'anonymous',
      email: null,
      name: 'Anonymous User',
      tier: 'free',
      isGuest: true
    };
    return next();
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
- Structure: Preserve lists, headings, tables, and code blocks when the prompt/mode requires them; otherwise prefer plain paragraphs.
- Output MUST be returned ONLY between <result> and </result> and MUST be a JSON array of strings with the SAME LENGTH as ITEMS.
- HARD 1:1 CHECK: The output array length MUST equal ITEMS length, and each index must correspond to its source index without moving words across items (no merging/splitting between indices). Example: If ITEMS[i] is "di nascosto", the output[i] MUST be "secretly" (or equivalent), and output[i-1] MUST NOT receive that adverb.
`.trim();

  const renderedBase = safeRenderTemplate(baseTmpl, {
    TARGET_LANG: targetLanguage || 'the same language as the input',
    TEXT: 'Apply the same style rules to every element of ITEMS.'
  });

  const injBlock = renderInjections(injections);

  const REPHRASE_GUARD = rephrase ? `
REPHRASE MODE (CRITICAL):
- Do NOT translate to any other language under any circumstance.
- Output must be in the SAME language as the input item.
- If the input is English, output English; if Indonesian, output Indonesian, etc.
- Improve clarity, tone, and fluency according to the selected style, but keep the language unchanged.
` : '';

  const header = `
You are an expert localization and translation assistant with advanced skills in cultural adaptation, style consistency, and terminology accuracy.
Always strictly follow the provided style, substyle, tone, and language style guidelines.
${STYLE_GUARD}
${needsSubtitleRules ? SUBTITLE_OVERRIDES : ''}

${injBlock ? injBlock + '\n' : ''}

${safeRenderTemplate(QA_BLOCK, {
  TARGET_LANG: targetLanguage || 'the same language as the input'
})}

${REPHRASE_GUARD}

${renderedBase}

BATCH INSTRUCTIONS:
- ITEMS is a JSON array of ${items.length} strings.
- ${rephrase ? 'REPHRASE each string in its original language (never translate or change language)' : `TRANSLATE/LOCALIZE each string into ${targetLanguage || 'the target language'}`}
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
  (req, res, next) => {
    // Debug authentication for translate-batch
    console.log('🔍 Translate-batch Auth Debug:', {
      userId: req.user?.id,
      tier: req.user?.tier,
      isGuest: req.user?.isGuest,
      hasAuthHeader: !!req.headers['authorization'],
      hasGuestHeader: !!req.headers['x-guest-id'],
      userObject: req.user
    });
    next();
  },
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

    // For subtitling/dubbing/dialogue, enforce strict 1:1 by micro-batching
    const isSubtitleLike = String(mode).toLowerCase() === 'dubbing' || String(subStyle).toLowerCase() === 'subtitling' || String(subStyle).toLowerCase() === 'dialogue';
    const chunks = isSubtitleLike
      ? items.map(x => [x])
      : chunkByTokenBudget(items, {
          maxTokensPerRequest: Number(process.env.BATCH_TOKENS || 7000),
          overheadTokens: 1200,
          outputFactor: 1.15,
          maxItemsPerChunk: 250
        });

    const temperature = pickTemperature(mode, subStyle, rephrase);
    const results = [];

    // Run with limited concurrency to keep UI responsive
    const CONCURRENCY = isSubtitleLike ? Number(process.env.SUBTITLE_CONCURRENCY || 4) : Number(process.env.BATCH_CONCURRENCY || 2);
    const queue = [...chunks];
    async function worker(){
      while(queue.length){
        const chunk = queue.shift();
        const prompt = buildBatchPrompt({ items: chunk, mode, subStyle, targetLanguage, rephrase, injections });
        const raw = await callOpenAIWithRetry({
          messages: [
            { role: 'system', content: 'You are an expert localization and translation assistant.' },
            { role: 'user', content: prompt }
          ],
          temperature
        });
        let arr = parseJsonArrayStrict(raw, chunk.length);
        for (let i = 0; i < arr.length; i++) {
          arr[i] = sanitizeWithSource(arr[i] || '', chunk[i] || '', targetLanguage);
        }
        results.push(...arr);
      }
    }
    const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker());
    await Promise.all(workers);

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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Phrasebook GET: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
    // Prefer Supabase REST with service role to avoid RLS issues on direct PG
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/phrasebook_items`);
      url.searchParams.set('user_id', `eq.${userIdForDb}`);
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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Phrasebook ADD: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
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
        body: JSON.stringify({ user_id: userIdForDb, src_text: String(it.srcText||''), tgt_text: String(it.tgtText||''), src_lang: String(it.srcLang||'Auto'), tgt_lang: String(it.tgtLang||'') })
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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Phrasebook DELETE: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
    const id = req.body?.id;
    if(!id) return res.status(400).json({ ok:false, error:'Missing id.' });
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/phrasebook_items`);
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${userIdForDb}`);
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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Brand Kits GET: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/brand_kits`);
      url.searchParams.set('user_id', `eq.${userIdForDb}`);
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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Brand Kits POST: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
    const { name = 'My Brand', tone = [], forbidden_words = [], style_notes = '' } = req.body || {};
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = `${process.env.SUPABASE_URL}/rest/v1/brand_kits`;
      const r = await fetch(url, {
        method:'POST',
        headers:{ 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', 'Prefer':'return=representation' },
        body: JSON.stringify({ user_id: userIdForDb, name, tone, forbidden_words, style_notes })
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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Brand Kits PUT: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
    const { name, tone, forbidden_words, style_notes } = req.body || {};
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/brand_kits`);
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${userIdForDb}`);
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
    
    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Brand Kits DELETE: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    }
    
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/brand_kits`);
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${userIdForDb}`);
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
      'SELECT month, requests, input_tokens, output_tokens FROM public.usage_monthly WHERE user_id = $1::uuid ORDER BY month DESC LIMIT 12',
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
    
    // Check if Prisma/Postgres is available and configured
    const hasPgUrl = typeof process.env.DATABASE_URL === 'string' && /^(postgres|postgresql):\/\//.test(process.env.DATABASE_URL || '');
    if (!prisma || !hasPgUrl) {
      if (!hasPgUrl) {
        console.warn('usage/current: DATABASE_URL missing or invalid; returning zero usage');
      }
      return res.json({
        used: 0,
        limit: tierConfig.maxInputSize,
        tier: tier,
        isGuest: false,
        percentage: 0,
        requests: 0
      });
    }
    
    // Resolve tier if not present on req.user (fallback to DB)
    let normalizedTier = String(tier || '').toLowerCase();
    if (!normalizedTier || !TIERS[normalizedTier]) {
      try {
        const rowsTier = await prisma.$queryRawUnsafe(
          'select tier from public.profiles where id = $1::uuid limit 1',
          userId
        );
        const dbTier = Array.isArray(rowsTier) && rowsTier[0]?.tier ? String(rowsTier[0].tier) : 'free';
        normalizedTier = TIERS[dbTier] ? dbTier : 'free';
      } catch (_) {
        normalizedTier = 'free';
      }
    }
    const effectiveTierConfig = TIERS[normalizedTier] || TIERS.free;

    // Handle legacy integer user IDs by converting to UUID format
    let userIdForDb = userId;
    if (typeof userId === 'number') {
      userIdForDb = `00000000-0000-0000-0000-${userId.toString().padStart(12, '0')}`;
      console.log(`Usage API: Converting legacy user ID ${userId} to UUID format: ${userIdForDb}`);
    } else if (typeof userId === 'string' && !userId.includes('-')) {
      // Handle string numbers too
      const numId = parseInt(userId);
      if (!isNaN(numId)) {
        userIdForDb = `00000000-0000-0000-0000-${numId.toString().padStart(12, '0')}`;
        console.log(`Usage API: Converting legacy string user ID ${userId} to UUID format: ${userIdForDb}`);
      }
    }

    // Get current month usage from Supabase (raw SQL to be resilient to Prisma schema mismatch)
    const month = monthStartISO();
    const rows = await prisma.$queryRawUnsafe(
      'select input_tokens, output_tokens, requests from public.usage_monthly where user_id = $1::uuid and month = $2::date limit 1',
      userIdForDb,
      month
    );
    const rec = Array.isArray(rows) && rows[0] ? rows[0] : null;

    // Calculate character usage (input + output tokens converted back to chars)
    const inputChars = Number(rec?.input_tokens || 0) * CHARS_PER_TOKEN;
    const outputChars = Number(rec?.output_tokens || 0) * CHARS_PER_TOKEN;
    const totalCharsUsed = Math.round(inputChars + outputChars);
    
    const percentage = Math.min((totalCharsUsed / effectiveTierConfig.maxInputSize) * 100, 100);
    
    const result = {
      used: totalCharsUsed,
      limit: effectiveTierConfig.maxInputSize,
      tier: normalizedTier,
      isGuest: false,
      percentage: percentage,
      requests: Number(rec?.requests || 0)
    };
    
    // Disable caching for real-time updates
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
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
      const r = await fetchWithTimeout(q.toString(), { headers: { 'Authorization': `Bearer ${SRK}`, 'apikey': SRK } });
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
    const rows = await prisma.$queryRawUnsafe('select tier from public.profiles where id = $1::uuid limit 1', req.user.id);
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
      const r = await fetchWithTimeout(q.toString(), { headers: { 'Authorization': `Bearer ${SRK}`, 'apikey': SRK } });
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
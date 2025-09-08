// translation-memory.js - Translation memory system for reusing previous translations
const crypto = require('crypto');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

/**
 * Translation Memory System
 * Stores and retrieves previous translations for reuse and consistency
 */
class TranslationMemoryManager {
  constructor() {
    this.db = require('./database');
    this.cache = require('./translation-cache').translationCache;
    
    this.config = {
      minSegmentLength: Number(process.env.TM_MIN_SEGMENT_LENGTH || 3),
      maxSegmentLength: Number(process.env.TM_MAX_SEGMENT_LENGTH || 500),
      fuzzyMatchThreshold: Number(process.env.TM_FUZZY_THRESHOLD || 0.75),
      exactMatchBonus: Number(process.env.TM_EXACT_MATCH_BONUS || 0.1),
      contextWindow: Number(process.env.TM_CONTEXT_WINDOW || 2),
      enableLeveraging: process.env.TM_ENABLE_LEVERAGING !== 'false',
      autoUpdate: process.env.TM_AUTO_UPDATE !== 'false'
    };

    this.stats = {
      exactMatches: 0,
      fuzzyMatches: 0,
      noMatches: 0,
      newSegments: 0,
      leveraged: 0
    };
  }

  /**
   * Initialize translation memory system
   */
  async init() {
    try {
      // Create TM tables if they don't exist
      await this.createTables();
      
      log.info('Translation Memory system initialized', {
        fuzzyThreshold: this.config.fuzzyMatchThreshold,
        leveragingEnabled: this.config.enableLeveraging
      });
    } catch (error) {
      log.error('Failed to initialize Translation Memory', { error: error.message });
      throw error;
    }
  }

  /**
   * Create necessary database tables for TM
   */
  async createTables() {
    const tableQueries = [
      `CREATE TABLE IF NOT EXISTS translation_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_hash TEXT UNIQUE NOT NULL,
        source_text TEXT NOT NULL,
        target_text TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        mode TEXT NOT NULL,
        sub_style TEXT DEFAULT '',
        quality_score REAL DEFAULT 1.0,
        usage_count INTEGER DEFAULT 1,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}'
      )`,
      
      `CREATE TABLE IF NOT EXISTS tm_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tm_id INTEGER NOT NULL,
        segment_text TEXT NOT NULL,
        segment_hash TEXT NOT NULL,
        position INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        FOREIGN KEY (tm_id) REFERENCES translation_memory (id) ON DELETE CASCADE
      )`,
      
      `CREATE TABLE IF NOT EXISTS tm_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tm_id INTEGER NOT NULL,
        preceding_text TEXT,
        following_text TEXT,
        document_id TEXT,
        file_type TEXT,
        FOREIGN KEY (tm_id) REFERENCES translation_memory (id) ON DELETE CASCADE
      )`,

      // Optional feedback table referenced by updateQualityScore
      `CREATE TABLE IF NOT EXISTS tm_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tm_id INTEGER NOT NULL,
        feedback TEXT,
        score REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tm_id) REFERENCES translation_memory (id) ON DELETE CASCADE
      )`
    ];

    for (const query of tableQueries) {
      await this.db.run(query);
    }

    const indexQueries = [
      `CREATE INDEX IF NOT EXISTS idx_tm_hash ON translation_memory (source_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_tm_langs ON translation_memory (source_lang, target_lang)`,
      `CREATE INDEX IF NOT EXISTS idx_tm_mode ON translation_memory (mode)`,
      `CREATE INDEX IF NOT EXISTS idx_tm_quality ON translation_memory (quality_score)`,
      `CREATE INDEX IF NOT EXISTS idx_segments_hash ON tm_segments (segment_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_segments_tm ON tm_segments (tm_id)`,
      `CREATE INDEX IF NOT EXISTS idx_context_tm ON tm_context (tm_id)`,
      `CREATE INDEX IF NOT EXISTS idx_context_doc ON tm_context (document_id)`
    ];

    for (const idx of indexQueries) {
      await this.db.run(idx);
    }
  }

  /**
   * Store translation in memory
   */
  async storeTranslation(sourceText, targetText, metadata = {}) {
    try {
      const {
        sourceLang = 'auto',
        targetLang,
        mode,
        subStyle = '',
        createdBy = null,
        qualityScore = 1.0,
        context = {},
        documentId = null
      } = metadata;

      // Generate hash for deduplication
      const sourceHash = this.generateSegmentHash(sourceText, sourceLang, targetLang, mode, subStyle);
      
      // Check if already exists
      const existing = await this.db.get(
        'SELECT id, usage_count FROM translation_memory WHERE source_hash = ?',
        [sourceHash]
      );

      let tmId;
      
      if (existing) {
        // Update existing entry
        await this.db.run(
          `UPDATE translation_memory 
           SET target_text = ?, usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [targetText, existing.id]
        );
        tmId = existing.id;
        this.stats.leveraged++;
      } else {
        // Create new entry
        const result = await this.db.run(
          `INSERT INTO translation_memory 
           (source_hash, source_text, target_text, source_lang, target_lang, mode, sub_style, 
            quality_score, created_by, metadata) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sourceHash,
            sourceText,
            targetText,
            sourceLang,
            targetLang,
            mode,
            subStyle,
            qualityScore,
            createdBy,
            JSON.stringify(metadata)
          ]
        );
        tmId = result.lastID;
        this.stats.newSegments++;
      }

      // Store segments for fuzzy matching
      await this.storeSegments(tmId, sourceText);
      
      // Store context if provided
      if (context.preceding || context.following || documentId) {
        await this.storeContext(tmId, context, documentId);
      }

      log.debug('Translation stored in memory', {
        tmId,
        sourceLength: sourceText.length,
        targetLength: targetText.length,
        mode,
        targetLang
      });

      recordMetrics.circuitBreakerSuccess('translation_memory:store');
      
      return tmId;
    } catch (error) {
      log.error('Failed to store translation in memory', { error: error.message });
      recordMetrics.circuitBreakerFailure('translation_memory:store');
      throw error;
    }
  }

  /**
   * Find translation matches
   */
  async findMatches(sourceText, metadata = {}) {
    try {
      const {
        sourceLang = 'auto',
        targetLang,
        mode,
        subStyle = '',
        context = {},
        includePartial = true
      } = metadata;

      const matches = [];

      // 1. Look for exact matches
      const exactMatch = await this.findExactMatch(sourceText, sourceLang, targetLang, mode, subStyle);
      if (exactMatch) {
        matches.push({
          ...exactMatch,
          matchType: 'exact',
          similarity: 1.0,
          leverage: 100
        });
        this.stats.exactMatches++;
      }

      // 2. Look for fuzzy matches if no exact match and partial matching is enabled
      if (includePartial && matches.length === 0) {
        const fuzzyMatches = await this.findFuzzyMatches(sourceText, sourceLang, targetLang, mode, subStyle);
        matches.push(...fuzzyMatches.map(match => ({
          ...match,
          matchType: 'fuzzy',
          leverage: Math.round(match.similarity * 100)
        })));
        
        if (fuzzyMatches.length > 0) {
          this.stats.fuzzyMatches++;
        }
      }

      // 3. Context-aware matching
      if (context.preceding || context.following) {
        const contextMatches = await this.findContextMatches(sourceText, context, metadata);
        matches.push(...contextMatches);
      }

      if (matches.length === 0) {
        this.stats.noMatches++;
      }

      recordMetrics.circuitBreakerSuccess('translation_memory:lookup');
      
      return matches.sort((a, b) => b.similarity - a.similarity);
      
    } catch (error) {
      log.error('TM match lookup failed', { error: error.message });
      recordMetrics.circuitBreakerFailure('translation_memory:lookup');
      return [];
    }
  }

  /**
   * Find exact translation match
   */
  async findExactMatch(sourceText, sourceLang, targetLang, mode, subStyle) {
    try {
      const sourceHash = this.generateSegmentHash(sourceText, sourceLang, targetLang, mode, subStyle);
      
      const match = await this.db.get(
        `SELECT * FROM translation_memory 
         WHERE source_hash = ? AND target_lang = ? AND mode = ? AND sub_style = ?
         ORDER BY quality_score DESC, usage_count DESC
         LIMIT 1`,
        [sourceHash, targetLang, mode, subStyle]
      );

      if (match) {
        // Update usage count
        await this.db.run(
          'UPDATE translation_memory SET usage_count = usage_count + 1 WHERE id = ?',
          [match.id]
        );
      }

      return match;
    } catch (error) {
      log.error('Exact match lookup failed', { error: error.message });
      return null;
    }
  }

  /**
   * Find fuzzy translation matches
   */
  async findFuzzyMatches(sourceText, sourceLang, targetLang, mode, subStyle, limit = 5) {
    try {
      // Get potential matches with same language pair and mode
      const candidates = await this.db.all(
        `SELECT tm.*, COUNT(s.id) as segment_matches
         FROM translation_memory tm
         LEFT JOIN tm_segments s ON tm.id = s.tm_id
         WHERE tm.target_lang = ? AND tm.mode = ? 
         AND tm.source_lang IN (?, 'auto')
         AND LENGTH(tm.source_text) BETWEEN ? AND ?
         GROUP BY tm.id
         ORDER BY segment_matches DESC, quality_score DESC, usage_count DESC
         LIMIT ?`,
        [
          targetLang,
          mode,
          sourceLang,
          Math.max(1, sourceText.length * 0.5),
          sourceText.length * 2,
          limit * 2 // Get more candidates for better filtering
        ]
      );

      const matches = [];
      
      for (const candidate of candidates) {
        const similarity = this.calculateDetailedSimilarity(sourceText, candidate.source_text);
        
        if (similarity >= this.config.fuzzyMatchThreshold) {
          matches.push({
            ...candidate,
            similarity,
            editDistance: this.calculateEditDistance(sourceText, candidate.source_text)
          });
        }
      }

      return matches
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
        
    } catch (error) {
      log.error('Fuzzy match lookup failed', { error: error.message });
      return [];
    }
  }

  /**
   * Find context-aware matches
   */
  async findContextMatches(sourceText, context, metadata) {
    try {
      const { targetLang, mode } = metadata;
      
      const contextMatches = await this.db.all(
        `SELECT tm.*, ctx.preceding_text, ctx.following_text,
                CASE 
                  WHEN ctx.preceding_text = ? THEN 0.1
                  ELSE 0
                END +
                CASE 
                  WHEN ctx.following_text = ? THEN 0.1
                  ELSE 0
                END as context_bonus
         FROM translation_memory tm
         JOIN tm_context ctx ON tm.id = ctx.tm_id
         WHERE tm.target_lang = ? AND tm.mode = ?
         AND (ctx.preceding_text LIKE ? OR ctx.following_text LIKE ?)
         ORDER BY context_bonus DESC, quality_score DESC
         LIMIT 3`,
        [
          context.preceding,
          context.following,
          targetLang,
          mode,
          `%${context.preceding}%`,
          `%${context.following}%`
        ]
      );

      return contextMatches.map(match => ({
        ...match,
        matchType: 'context',
        similarity: this.calculateDetailedSimilarity(sourceText, match.source_text) + match.context_bonus,
        contextBonus: match.context_bonus
      }));
      
    } catch (error) {
      log.error('Context match lookup failed', { error: error.message });
      return [];
    }
  }

  /**
   * Store text segments for fuzzy matching
   */
  async storeSegments(tmId, sourceText) {
    try {
      const segments = this.segmentText(sourceText);
      
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentHash = crypto.createHash('md5').update(segment.toLowerCase()).digest('hex');
        
        await this.db.run(
          `INSERT OR IGNORE INTO tm_segments 
           (tm_id, segment_text, segment_hash, position, word_count) 
           VALUES (?, ?, ?, ?, ?)`,
          [tmId, segment, segmentHash, i, segment.split(/\s+/).length]
        );
      }
    } catch (error) {
      log.error('Failed to store segments', { tmId, error: error.message });
    }
  }

  /**
   * Store context information
   */
  async storeContext(tmId, context, documentId) {
    try {
      await this.db.run(
        `INSERT INTO tm_context 
         (tm_id, preceding_text, following_text, document_id, file_type) 
         VALUES (?, ?, ?, ?, ?)`,
        [
          tmId,
          context.preceding || null,
          context.following || null,
          documentId || null,
          context.fileType || null
        ]
      );
    } catch (error) {
      log.error('Failed to store context', { tmId, error: error.message });
    }
  }

  /**
   * Segment text into meaningful units
   */
  segmentText(text) {
    // Split by sentences and paragraphs
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const segments = [];
    
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.length >= this.config.minSegmentLength && 
          trimmed.length <= this.config.maxSegmentLength) {
        segments.push(trimmed);
      }
    }
    
    // If no good segments found, use word-based chunking
    if (segments.length === 0) {
      const words = text.split(/\s+/);
      const chunkSize = 10; // 10 words per segment
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        if (chunk.length >= this.config.minSegmentLength) {
          segments.push(chunk);
        }
      }
    }
    
    return segments;
  }

  /**
   * Calculate detailed similarity between two texts
   */
  calculateDetailedSimilarity(text1, text2) {
    if (text1 === text2) return 1.0;
    
    // Normalize texts
    const norm1 = text1.toLowerCase().trim();
    const norm2 = text2.toLowerCase().trim();
    
    if (norm1 === norm2) return 1.0;
    
    // Calculate various similarity metrics
    const editSimilarity = 1 - (this.calculateEditDistance(norm1, norm2) / Math.max(norm1.length, norm2.length));
    const wordSimilarity = this.calculateWordSimilarity(norm1, norm2);
    const ngramSimilarity = this.calculateNGramSimilarity(norm1, norm2, 3);
    
    // Weighted combination
    const similarity = (editSimilarity * 0.4) + (wordSimilarity * 0.4) + (ngramSimilarity * 0.2);
    
    return Math.round(similarity * 1000) / 1000; // Round to 3 decimal places
  }

  /**
   * Calculate edit distance (Levenshtein distance)
   */
  calculateEditDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));
    
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }
    
    return dp[m][n];
  }

  /**
   * Calculate word-level similarity
   */
  calculateWordSimilarity(text1, text2) {
    const words1 = new Set(text1.split(/\s+/));
    const words2 = new Set(text2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Calculate n-gram similarity
   */
  calculateNGramSimilarity(text1, text2, n = 3) {
    const ngrams1 = this.generateNGrams(text1, n);
    const ngrams2 = this.generateNGrams(text2, n);
    
    const set1 = new Set(ngrams1);
    const set2 = new Set(ngrams2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Generate n-grams from text
   */
  generateNGrams(text, n) {
    const ngrams = [];
    const cleanText = text.replace(/\s+/g, ' ').trim();
    
    for (let i = 0; i <= cleanText.length - n; i++) {
      ngrams.push(cleanText.substring(i, i + n));
    }
    
    return ngrams;
  }

  /**
   * Generate hash for segment identification
   */
  generateSegmentHash(sourceText, sourceLang, targetLang, mode, subStyle) {
    const content = [sourceText.toLowerCase().trim(), sourceLang, targetLang, mode, subStyle].join('::');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get translation suggestions with leverage information
   */
  async getTranslationSuggestions(sourceText, metadata = {}) {
    try {
      const matches = await this.findMatches(sourceText, metadata);
      
      const suggestions = matches.map(match => ({
        id: match.id,
        sourceText: match.source_text,
        targetText: match.target_text,
        similarity: match.similarity,
        leverage: match.leverage,
        matchType: match.matchType,
        qualityScore: match.quality_score,
        usageCount: match.usage_count,
        lastUsed: match.updated_at,
        metadata: JSON.parse(match.metadata || '{}')
      }));

      return suggestions;
    } catch (error) {
      log.error('Failed to get translation suggestions', { error: error.message });
      return [];
    }
  }

  /**
   * Leverage existing translation (apply to new text)
   */
  async leverageTranslation(sourceText, matchId, modifications = {}) {
    try {
      const match = await this.db.get(
        'SELECT * FROM translation_memory WHERE id = ?',
        [matchId]
      );

      if (!match) {
        throw new Error('Translation match not found');
      }

      // Apply modifications if any
      let leveragedTranslation = match.target_text;
      
      if (modifications.replacements) {
        for (const [find, replace] of Object.entries(modifications.replacements)) {
          leveragedTranslation = leveragedTranslation.replace(new RegExp(find, 'gi'), replace);
        }
      }

      // Update usage count
      await this.db.run(
        'UPDATE translation_memory SET usage_count = usage_count + 1 WHERE id = ?',
        [matchId]
      );

      this.stats.leveraged++;
      recordMetrics.circuitBreakerSuccess('translation_memory:leverage');

      log.debug('Translation leveraged', { 
        matchId, 
        originalLength: match.source_text.length,
        newLength: sourceText.length,
        similarity: this.calculateDetailedSimilarity(sourceText, match.source_text)
      });

      return {
        translation: leveragedTranslation,
        confidence: match.quality_score,
        original: match.target_text,
        modified: leveragedTranslation !== match.target_text
      };
      
    } catch (error) {
      log.error('Translation leverage failed', { matchId, error: error.message });
      throw error;
    }
  }

  /**
   * Update translation quality score
   */
  async updateQualityScore(tmId, newScore, feedback = '') {
    try {
      await this.db.run(
        'UPDATE translation_memory SET quality_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newScore, tmId]
      );

      // Store feedback if provided
      if (feedback) {
        await this.db.run(
          `INSERT INTO tm_feedback (tm_id, feedback, score, created_at) 
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
          [tmId, feedback, newScore]
        );
      }

      log.debug('Translation quality updated', { tmId, newScore, feedback: !!feedback });
      
    } catch (error) {
      log.error('Failed to update quality score', { tmId, error: error.message });
    }
  }

  /**
   * Get TM statistics
   */
  async getTMStatistics() {
    try {
      const dbStats = await this.db.get(`
        SELECT 
          COUNT(*) as total_entries,
          AVG(quality_score) as avg_quality,
          SUM(usage_count) as total_usage,
          COUNT(DISTINCT target_lang) as languages,
          COUNT(DISTINCT mode) as modes
        FROM translation_memory
      `);

      return {
        database: dbStats,
        runtime: this.stats,
        config: this.config
      };
    } catch (error) {
      log.error('Failed to get TM statistics', { error: error.message });
      return { error: error.message };
    }
  }

  /**
   * Export translation memory
   */
  async exportTM(filters = {}) {
    try {
      let whereClause = '1=1';
      const params = [];

      if (filters.targetLang) {
        whereClause += ' AND target_lang = ?';
        params.push(filters.targetLang);
      }

      if (filters.mode) {
        whereClause += ' AND mode = ?';
        params.push(filters.mode);
      }

      if (filters.minQuality) {
        whereClause += ' AND quality_score >= ?';
        params.push(filters.minQuality);
      }

      const translations = await this.db.all(
        `SELECT source_text, target_text, source_lang, target_lang, mode, sub_style,
                quality_score, usage_count, created_at, updated_at
         FROM translation_memory 
         WHERE ${whereClause}
         ORDER BY quality_score DESC, usage_count DESC`,
        params
      );

      return {
        exportDate: new Date().toISOString(),
        filters,
        count: translations.length,
        translations
      };
    } catch (error) {
      log.error('TM export failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Health check for translation memory system
   */
  async healthCheck() {
    try {
      const stats = await this.getTMStatistics();
      
      return {
        status: 'healthy',
        entries: stats.database?.total_entries || 0,
        avgQuality: Math.round((stats.database?.avg_quality || 0) * 100) / 100,
        languages: stats.database?.languages || 0,
        leverageRate: this.stats.exactMatches + this.stats.fuzzyMatches > 0 ? 
          ((this.stats.exactMatches + this.stats.fuzzyMatches) / 
           (this.stats.exactMatches + this.stats.fuzzyMatches + this.stats.noMatches)) : 0
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

// Global TM manager instance
const translationMemory = new TranslationMemoryManager();

/**
 * Middleware to add TM capabilities to requests
 */
function translationMemoryMiddleware(req, res, next) {
  req.tm = {
    findMatches: (sourceText, metadata) => translationMemory.findMatches(sourceText, metadata),
    getSuggestions: (sourceText, metadata) => translationMemory.getTranslationSuggestions(sourceText, metadata),
    store: (sourceText, targetText, metadata) => translationMemory.storeTranslation(sourceText, targetText, metadata),
    leverage: (sourceText, matchId, modifications) => translationMemory.leverageTranslation(sourceText, matchId, modifications),
    updateQuality: (tmId, score, feedback) => translationMemory.updateQualityScore(tmId, score, feedback),
    getStats: () => translationMemory.getTMStatistics(),
    export: (filters) => translationMemory.exportTM(filters),
    healthCheck: () => translationMemory.healthCheck()
  };
  next();
}

/**
 * Initialize translation memory system
 */
async function initTranslationMemory() {
  await translationMemory.init();
  return translationMemory;
}

module.exports = {
  TranslationMemoryManager,
  translationMemory,
  translationMemoryMiddleware,
  initTranslationMemory
};



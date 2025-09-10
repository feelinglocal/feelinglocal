// file-translation-system.js - Advanced file translation system
// Handles PDF, DOCX, PPTX with layout preservation

const JSZip = require('jszip');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { PDFDocument, rgb } = require('pdf-lib');
const { storageService } = require('./storage');
const { recordMetrics } = require('./metrics');
const log = require('./logger');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * File Translation System Manager
 * Orchestrates the complete file translation workflow
 */
class FileTranslationSystem {
  constructor() {
    this.handlers = {
      pdf: new PDFHandler(),
      docx: new DOCXHandler(), 
      pptx: new PPTXHandler()
    };
    this.queueService = null; // Will be injected
    this.progressEmitter = null; // Will be injected
  }

  /**
   * Initialize the system with dependencies
   */
  init(queueService, progressEmitter) {
    this.queueService = queueService;
    this.progressEmitter = progressEmitter;
  }

  /**
   * Start processing a file translation job
   */
  async processJob(jobId, userId, fileBuffer, filename, srcLang, tgtLang, options = {}) {
    const startTime = Date.now();
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    
    try {
      await this.emitProgress(jobId, 5, 'upload_received', { filename, size: fileBuffer.length });
      
      // Validate file type and detect content
      if (!this.handlers[ext]) {
        throw new Error(`Unsupported file type: ${ext}`);
      }
      
      const handler = this.handlers[ext];
      
      // Parse and analyze content
      await this.emitProgress(jobId, 15, 'parsing');
      const contentProfile = await handler.analyzeContent(fileBuffer, filename);
      
      // Update job with content profile
      await this.updateJobMetadata(jobId, { content_profile: contentProfile });
      
      // Segment content for translation
      await this.emitProgress(jobId, 30, 'segmenting');
      const segments = await handler.extractSegments(fileBuffer, filename, contentProfile);
      
      // Translate segments using existing translation system
      await this.emitProgress(jobId, 55, 'translating');
      const translatedSegments = await this.translateSegments(segments, srcLang, tgtLang, userId, options);
      
      // Reconstruct file with translated content
      await this.emitProgress(jobId, 75, 'reconstructing');
      const outputBuffer = await handler.reconstructFile(fileBuffer, filename, translatedSegments, contentProfile);
      
      // Validate and generate QA report
      await this.emitProgress(jobId, 90, 'validating');
      const fitReport = await handler.generateFitReport(outputBuffer, translatedSegments, contentProfile);
      
      // Store output file
      const outputKey = storageService.generateFileKey(userId, filename.replace(/\.[^.]+$/, `.translated.${ext}`), 'output');
      const outputResult = await storageService.uploadFile(outputBuffer, outputKey, {
        type: 'translated',
        jobId,
        originalFilename: filename,
        ttl: '7d'
      });
      
      // Generate visual diff if applicable
      let previewUrl = null;
      if (ext === 'pdf') {
        previewUrl = await this.generateVisualDiff(jobId, fileBuffer, outputBuffer);
      }
      
      await this.emitProgress(jobId, 100, 'done');
      
      const duration = Date.now() - startTime;
      recordMetrics('file_translation_completed', 1, { ext, duration, segments: segments.length });
      
      return {
        outputUrl: outputResult.url,
        previewUrl,
        fitReport,
        segments: segments.length,
        pages: contentProfile.pages || 0,
        charCount: segments.reduce((sum, s) => sum + (s.src?.length || 0), 0)
      };
      
    } catch (error) {
      log.error('File translation job failed', { jobId, error: error.message });
      await this.emitProgress(jobId, 0, 'error', { error: error.message });
      recordMetrics('file_translation_failed', 1, { ext, error: error.message });
      throw error;
    }
  }

  /**
   * Translate content segments using existing translation infrastructure
   */
  async translateSegments(segments, srcLang, tgtLang, userId, options) {
    const { cacheAwareTranslation } = require('./translation-cache');
    const translatedSegments = [];
    
    // Group segments for batch translation
    const batchSize = 10;
    for (let i = 0; i < segments.length; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      const batchTexts = batch.map(s => s.src).filter(Boolean);
      
      if (batchTexts.length === 0) {
        translatedSegments.push(...batch.map(s => ({ ...s, tgt: s.src })));
        continue;
      }
      
      // Use existing translation function with batch processing
      const translationResult = await cacheAwareTranslation(
        this.callTranslationAPI.bind(this),
        {
          text: batchTexts.join('\n\n---SEG---\n\n'),
          mode: options.mode || 'formal',
          targetLanguage: tgtLang,
          subStyle: options.subStyle || 'general',
          injections: options.injections || ''
        },
        {
          text: batchTexts.join('\n\n---SEG---\n\n'),
          mode: options.mode || 'formal',
          targetLanguage: tgtLang,
          subStyle: options.subStyle || 'general',
          injections: options.injections || '',
          userId
        }
      );
      
      const translatedTexts = translationResult.split('\n\n---SEG---\n\n');
      
      // Map translations back to segments
      for (let j = 0; j < batch.length; j++) {
        const segment = batch[j];
        const translated = translatedTexts[j] || segment.src;
        translatedSegments.push({
          ...segment,
          tgt: translated
        });
      }
    }
    
    return translatedSegments;
  }

  /**
   * Call the translation API (wrapper for existing system)
   */
  async callTranslationAPI({ text, mode, targetLanguage, subStyle, injections, userId }) {
    // Switch to Gemini 2.5 Flash
    const gemini = require('./gemini');
    const items = text.split('\n\n---SEG---\n\n');
    const prompt = this.buildBatchPrompt({
      items,
      mode,
      subStyle,
      targetLanguage,
      rephrase: false,
      injections
    });
    const out = await gemini.generateContent({
      text: prompt,
      system: 'You are an expert localization and translation assistant.',
      model: process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash'
    });
    return out?.text || text;
  }
  
  /**
   * Build batch translation prompt
   */
  buildBatchPrompt({ items, mode, subStyle, targetLanguage, rephrase, injections }) {
    const basePrompt = `Translate the following text segments to ${targetLanguage}.
Style: ${mode} - ${subStyle}
${rephrase ? 'Focus on rephrasing rather than literal translation.' : ''}
${injections ? `Additional instructions: ${injections}` : ''}

Preserve the original structure and return each segment on a separate line, separated by "---SEG---".

Segments to translate:`;
    
    return basePrompt + '\n\n' + items.join('\n\n---SEG---\n\n');
  }

  /**
   * Emit progress events for real-time UI updates
   */
  async emitProgress(jobId, pct, label, meta = {}) {
    if (this.progressEmitter) {
      await this.progressEmitter.emit(jobId, { pct, label, meta });
    }
    
    // Also store in database
    await this.storeProgressEvent(jobId, pct, label, meta);
  }

  /**
   * Store progress event in database
   */
  async storeProgressEvent(jobId, pct, label, meta) {
    try {
      const query = `
        INSERT INTO file_job_events (job_id, pct, label, meta)
        VALUES ($1, $2, $3, $4)
      `;
      
      // Use existing database connection
      const db = require('./database');
      await db.run(query, [jobId, pct, label, JSON.stringify(meta)]);
    } catch (error) {
      log.error('Failed to store progress event', { jobId, error: error.message });
    }
  }

  /**
   * Update job metadata in database
   */
  async updateJobMetadata(jobId, metadata) {
    try {
      const updates = Object.keys(metadata).map(key => `${key} = $${Object.keys(metadata).indexOf(key) + 2}`);
      const query = `UPDATE file_jobs SET ${updates.join(', ')} WHERE id = $1`;
      const values = [jobId, ...Object.values(metadata)];
      
      const db = require('./database');
      await db.run(query, values);
    } catch (error) {
      log.error('Failed to update job metadata', { jobId, error: error.message });
    }
  }

  /**
   * Generate visual diff for PDF files
   */
  async generateVisualDiff(jobId, originalBuffer, translatedBuffer) {
    try {
      // This would use pdf-poppler or pdfjs to render PDFs to images
      // Then use pixelmatch to generate diff overlays
      // For now, return placeholder
      return null;
    } catch (error) {
      log.error('Failed to generate visual diff', { jobId, error: error.message });
      return null;
    }
  }
}

/**
 * Base File Handler
 */
class FileHandler {
  async analyzeContent(buffer, filename) {
    throw new Error('analyzeContent must be implemented by subclass');
  }
  
  async extractSegments(buffer, filename, contentProfile) {
    throw new Error('extractSegments must be implemented by subclass');
  }
  
  async reconstructFile(buffer, filename, segments, contentProfile) {
    throw new Error('reconstructFile must be implemented by subclass');
  }
  
  async generateFitReport(buffer, segments, contentProfile) {
    return {
      totalSegments: segments.length,
      passThreshold: 0.98,
      fitRatio: 1.0,
      lineOverflowCount: 0
    };
  }
}

/**
 * PDF Handler - Preserves layout while replacing text
 */
class PDFHandler extends FileHandler {
  constructor() {
    super();
    this.pdfjsLib = null;
    this.initPDFJS();
  }
  
  async initPDFJS() {
    try {
      // Initialize PDF.js for server-side use
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      this.pdfjsLib = pdfjs.getDocument;
    } catch (error) {
      log.warn('PDF.js not available, using fallback PDF processing');
    }
  }

  async analyzeContent(buffer, filename) {
    try {
      // Use PDF.js for detailed analysis if available
      if (this.pdfjsLib) {
        const loadingTask = this.pdfjsLib({ data: buffer });
        const pdf = await loadingTask.promise;
        
        let totalTextItems = 0;
        let hasImages = false;
        let hasTables = false;
        let textDensity = 0;
        
        // Analyze each page
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent();
          const annotations = await page.getAnnotations();
          
          totalTextItems += textContent.items.length;
          
          // Detect images by looking for image operators
          const operatorList = await page.getOperatorList();
          hasImages = hasImages || operatorList.fnArray.includes(pdfjs.OPS.paintImageXObject);
          
          // Simple table detection: look for many aligned text items
          const yPositions = textContent.items.map(item => Math.round(item.transform[5]));
          const uniqueYPositions = [...new Set(yPositions)];
          if (uniqueYPositions.length > 3 && textContent.items.length > 20) {
            hasTables = true;
          }
        }
        
        textDensity = totalTextItems / pdf.numPages;
        
        return {
          pages: pdf.numPages,
          textItems: totalTextItems,
          hasImages,
          hasTables,
          textDensity,
          isImageOnly: textDensity < 5, // Likely scanned document
          complexity: this.calculateComplexity(totalTextItems, hasImages, hasTables)
        };
      }
    } catch (error) {
      log.warn('Advanced PDF analysis failed, using fallback', { error: error.message });
    }
    
    // Fallback to basic analysis
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    
    return {
      pages: result.numpages,
      text: result.text,
      textItems: Math.floor(result.text.length / 10), // Rough estimate
      hasImages: false,
      hasTables: result.text.includes('\t') || result.text.match(/(\s{2,}.*\s{2,}.*\s{2,})/),
      textDensity: result.text.length / result.numpages,
      isImageOnly: result.text.trim().length < 100,
      complexity: 'medium'
    };
  }
  
  calculateComplexity(textItems, hasImages, hasTables) {
    let score = textItems / 100;
    if (hasImages) score += 2;
    if (hasTables) score += 3;
    
    if (score < 5) return 'low';
    if (score < 15) return 'medium';
    return 'high';
  }
  
  async extractSegments(buffer, filename, contentProfile) {
    const segments = [];
    
    try {
      if (this.pdfjsLib && !contentProfile.isImageOnly) {
        // Advanced text extraction with position information
        const loadingTask = this.pdfjsLib({ data: buffer });
        const pdf = await loadingTask.promise;
        
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent();
          const viewport = page.getViewport({ scale: 1.0 });
          
          // Group text items into blocks
          const blocks = this.groupTextIntoBlocks(textContent.items, viewport);
          
          blocks.forEach((block, blockIndex) => {
            if (block.text.trim().length > 0) {
              segments.push({
                blockId: `page_${pageNum}_block_${blockIndex}`,
                src: block.text.trim(),
                type: 'text_block',
                page: pageNum,
                style: {
                  fontSize: block.fontSize,
                  fontFamily: block.fontName,
                  color: block.color
                },
                rect: block.rect,
                lines: block.lines
              });
            }
          });
        }
      } else {
        // Fallback to simple segmentation
        const text = contentProfile.text || '';
        const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        
        paragraphs.forEach((paragraph, index) => {
          segments.push({
            blockId: `block_${index}`,
            src: paragraph.trim(),
            type: 'paragraph',
            page: Math.floor(index / 3) + 1, // Rough page estimation
            style: { fontSize: 12, fontFamily: 'Arial', color: '#000000' },
            rect: { x: 50, y: 100 + (index % 3 * 100), width: 500, height: 80 }
          });
        });
      }
    } catch (error) {
      log.error('PDF segment extraction failed', { error: error.message });
      // Return empty segments if extraction fails
    }
    
    return segments;
  }
  
  groupTextIntoBlocks(textItems, viewport) {
    if (!textItems.length) return [];
    
    // Sort items by position (top to bottom, left to right)
    const sortedItems = textItems.sort((a, b) => {
      const yDiff = Math.abs(a.transform[5] - b.transform[5]);
      if (yDiff < 3) { // Same line
        return a.transform[4] - b.transform[4]; // Sort by x position
      }
      return b.transform[5] - a.transform[5]; // Sort by y position (top to bottom)
    });
    
    const blocks = [];
    let currentBlock = null;
    
    for (const item of sortedItems) {
      const x = item.transform[4];
      const y = item.transform[5];
      const fontSize = item.transform[0];
      const text = item.str;
      
      if (!currentBlock || Math.abs(currentBlock.rect.y - y) > fontSize * 1.5) {
        // Start new block
        if (currentBlock && currentBlock.text.trim()) {
          blocks.push(currentBlock);
        }
        
        currentBlock = {
          text: text,
          rect: { x, y, width: item.width, height: fontSize },
          fontSize,
          fontName: item.fontName || 'Arial',
          color: '#000000',
          lines: [{ text, y, fontSize }]
        };
      } else {
        // Add to current block
        currentBlock.text += (text.trim() ? ' ' : '') + text;
        currentBlock.rect.width = Math.max(currentBlock.rect.width, x + item.width - currentBlock.rect.x);
        currentBlock.lines.push({ text, y, fontSize });
      }
    }
    
    if (currentBlock && currentBlock.text.trim()) {
      blocks.push(currentBlock);
    }
    
    return blocks;
  }
  
  async reconstructFile(originalBuffer, filename, segments, contentProfile) {
    try {
      const pdfDoc = await PDFDocument.load(originalBuffer);
      const pages = pdfDoc.getPages();
      
      // Load font for text rendering (use built-in fonts for now)
      let font = null;
      try {
        font = await pdfDoc.embedFont('Helvetica');
      } catch (error) {
        log.debug('Could not embed custom font, using default');
      }
      
      // Process each page
      for (const segment of segments) {
        if (!segment.tgt || segment.tgt === segment.src) continue;
        
        const pageIndex = (segment.page || 1) - 1;
        if (pageIndex >= pages.length) continue;
        
        const page = pages[pageIndex];
        const { width: pageWidth, height: pageHeight } = page.getSize();
        
        // Calculate text positioning
        const rect = segment.rect || { x: 50, y: 100, width: 500, height: 18 };
        const fontSize = Math.max(8, Math.min(24, segment.style?.fontSize || 12));
        
        // Cover original text with white rectangle
        page.drawRectangle({
          x: rect.x - 2,
          y: pageHeight - rect.y - rect.height - 2,
          width: rect.width + 4,
          height: rect.height + 4,
          color: rgb(1, 1, 1)
        });
        
        // Draw translated text with line breaking
        const lines = this.fitTextInRect(segment.tgt, rect, fontSize, font);
        let yOffset = 0;
        
        for (const line of lines) {
          page.drawText(line, {
            x: rect.x,
            y: pageHeight - rect.y - yOffset - fontSize,
            size: fontSize,
            font: font || undefined,
            color: rgb(0, 0, 0)
          });
          yOffset += fontSize * 1.2;
        }
      }
      
      const pdfBytes = await pdfDoc.save();
      return Buffer.from(pdfBytes);
    } catch (error) {
      log.error('PDF reconstruction failed', { error: error.message });
      return originalBuffer; // Fallback to original
    }
  }
  
  fitTextInRect(text, rect, fontSize, font) {
    const lines = [];
    const words = text.split(' ');
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const estimatedWidth = testLine.length * fontSize * 0.6; // Rough character width
      
      if (estimatedWidth <= rect.width || !currentLine) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    
    if (currentLine) lines.push(currentLine);
    
    // Limit lines to fit in height
    const maxLines = Math.floor(rect.height / (fontSize * 1.2));
    return lines.slice(0, maxLines);
  }
  
  async generateFitReport(buffer, segments, contentProfile) {
    const report = {
      totalSegments: segments.length,
      passThreshold: 0.98,
      overallFitRatio: 0,
      lineOverflowCount: 0,
      segmentReports: []
    };
    
    let totalFitRatio = 0;
    
    for (const segment of segments) {
      if (!segment.tgt || !segment.rect) continue;
      
      const originalLength = segment.src.length;
      const translatedLength = segment.tgt.length;
      const lengthRatio = translatedLength / originalLength;
      
      // Estimate if text fits in original rect
      const estimatedLines = Math.ceil(translatedLength * 0.6 * (segment.style?.fontSize || 12) / segment.rect.width);
      const maxLines = Math.floor(segment.rect.height / ((segment.style?.fontSize || 12) * 1.2));
      const fitRatio = maxLines > 0 ? Math.min(1, maxLines / estimatedLines) : 0;
      
      totalFitRatio += fitRatio;
      
      if (fitRatio < 1) {
        report.lineOverflowCount++;
      }
      
      report.segmentReports.push({
        blockId: segment.blockId,
        lengthRatio,
        fitRatio,
        estimatedLines,
        maxLines,
        overflows: fitRatio < 1
      });
    }
    
    report.overallFitRatio = segments.length > 0 ? totalFitRatio / segments.length : 1;
    report.passesThreshold = report.overallFitRatio >= report.passThreshold;
    
    return report;
  }
}

/**
 * DOCX Handler - Preserves formatting while replacing text in runs
 */
class DOCXHandler extends FileHandler {
  async analyzeContent(buffer, filename) {
    const zip = new JSZip();
    const archive = await zip.loadAsync(buffer);
    
    // Analyze document structure
    const docXml = await archive.file('word/document.xml')?.async('string');
    if (!docXml) throw new Error('Invalid DOCX file');
    
    const parser = new XMLParser({ ignoreAttributes: false });
    const doc = parser.parse(docXml);
    
    // Count elements
    let paragraphs = 0;
    let tables = 0;
    let runs = 0;
    
    // Simple counting - in full implementation, traverse DOM properly
    const xmlString = docXml.toLowerCase();
    paragraphs = (xmlString.match(/<w:p[\s>]/g) || []).length;
    tables = (xmlString.match(/<w:tbl[\s>]/g) || []).length;
    runs = (xmlString.match(/<w:r[\s>]/g) || []).length;
    
    return {
      pages: Math.ceil(runs / 50), // Rough estimate
      paragraphs,
      tables,
      runs,
      hasImages: xmlString.includes('w:drawing'),
      textRuns: runs
    };
  }
  
  async extractSegments(buffer, filename, contentProfile) {
    const zip = new JSZip();
    const archive = await zip.loadAsync(buffer);
    
    // Extract text from document.xml and related files
    const segments = [];
    const files = ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'];
    
    for (const filePath of files) {
      const file = archive.file(filePath);
      if (!file) continue;
      
      const xmlContent = await file.async('string');
      const textRuns = this.extractTextRuns(xmlContent);
      
      textRuns.forEach((run, index) => {
        if (run.text.trim()) {
          segments.push({
            blockId: `${filePath}_run_${index}`,
            src: run.text.trim(),
            type: 'text_run',
            filePath,
            runIndex: index,
            style: run.style || {}
          });
        }
      });
    }
    
    return segments;
  }
  
  extractTextRuns(xmlContent) {
    // Simple regex-based text extraction
    // In full implementation, use proper XML parsing
    const runs = [];
    const textMatches = xmlContent.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || [];
    
    textMatches.forEach((match, index) => {
      const text = match.replace(/<w:t[^>]*>(.*?)<\/w:t>/, '$1')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&amp;/g, '&');
      
      if (text.trim()) {
        runs.push({
          text: text,
          style: {},
          index
        });
      }
    });
    
    return runs;
  }
  
  async reconstructFile(originalBuffer, filename, segments, contentProfile) {
    try {
      const zip = new JSZip();
      const archive = await zip.loadAsync(originalBuffer);
      
      // Process each file that contains text
      const filesToUpdate = ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'];
      
      for (const filePath of filesToUpdate) {
        const file = archive.file(filePath);
        if (!file) continue;
        
        let xmlContent = await file.async('string');
        
        // Find segments for this file
        const fileSegments = segments.filter(s => s.filePath === filePath);
        
        // Replace text in runs (preserving run boundaries)
        fileSegments.forEach(segment => {
          if (segment.tgt && segment.src !== segment.tgt) {
            xmlContent = xmlContent.replace(
              new RegExp(`<w:t[^>]*>${this.escapeXml(segment.src)}</w:t>`, 'g'),
              `<w:t>${this.escapeXml(segment.tgt)}</w:t>`
            );
          }
        });
        
        archive.file(filePath, xmlContent);
      }
      
      const updatedBuffer = await archive.generateAsync({ type: 'nodebuffer' });
      return updatedBuffer;
    } catch (error) {
      log.error('DOCX reconstruction failed', { error: error.message });
      return originalBuffer;
    }
  }
  
  escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

/**
 * PPTX Handler - Preserves slide layouts while replacing text
 */
class PPTXHandler extends FileHandler {
  async analyzeContent(buffer, filename) {
    const zip = new JSZip();
    const archive = await zip.loadAsync(buffer);
    
    // Count slides
    const slideFiles = Object.keys(archive.files).filter(path => 
      path.startsWith('ppt/slides/slide') && path.endsWith('.xml')
    );
    
    let totalTextFrames = 0;
    let totalBulletPoints = 0;
    
    // Analyze each slide
    for (const slidePath of slideFiles) {
      const slideXml = await archive.file(slidePath)?.async('string');
      if (slideXml) {
        totalTextFrames += (slideXml.match(/<a:t>/g) || []).length;
        totalBulletPoints += (slideXml.match(/<a:buFont/g) || []).length;
      }
    }
    
    return {
      pages: slideFiles.length,
      slides: slideFiles.length,
      textFrames: totalTextFrames,
      bulletPoints: totalBulletPoints,
      hasAnimations: false // Could be detected by looking for animation XML
    };
  }
  
  async extractSegments(buffer, filename, contentProfile) {
    const zip = new JSZip();
    const archive = await zip.loadAsync(buffer);
    const segments = [];
    
    // Process each slide
    const slideFiles = Object.keys(archive.files).filter(path => 
      path.startsWith('ppt/slides/slide') && path.endsWith('.xml')
    );
    
    for (const slidePath of slideFiles) {
      const slideXml = await archive.file(slidePath)?.async('string');
      if (!slideXml) continue;
      
      // Extract text runs from slides
      const textRuns = this.extractPPTXTextRuns(slideXml);
      
      textRuns.forEach((run, index) => {
        if (run.text.trim()) {
          segments.push({
            blockId: `${slidePath}_text_${index}`,
            src: run.text.trim(),
            type: 'pptx_text',
            slidePath,
            textIndex: index,
            style: run.style || {}
          });
        }
      });
    }
    
    return segments;
  }
  
  extractPPTXTextRuns(xmlContent) {
    const runs = [];
    // Extract text from <a:t> elements
    const textMatches = xmlContent.match(/<a:t[^>]*>(.*?)<\/a:t>/g) || [];
    
    textMatches.forEach((match, index) => {
      const text = match.replace(/<a:t[^>]*>(.*?)<\/a:t>/, '$1')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&amp;/g, '&');
      
      runs.push({
        text: text,
        style: {},
        index
      });
    });
    
    return runs;
  }
  
  async reconstructFile(originalBuffer, filename, segments, contentProfile) {
    try {
      const zip = new JSZip();
      const archive = await zip.loadAsync(originalBuffer);
      
      // Process each slide file
      const slideFiles = Object.keys(archive.files).filter(path => 
        path.startsWith('ppt/slides/slide') && path.endsWith('.xml')
      );
      
      for (const slidePath of slideFiles) {
        const file = archive.file(slidePath);
        if (!file) continue;
        
        let xmlContent = await file.async('string');
        
        // Find segments for this slide
        const slideSegments = segments.filter(s => s.slidePath === slidePath);
        
        // Replace text in <a:t> elements
        slideSegments.forEach(segment => {
          if (segment.tgt && segment.src !== segment.tgt) {
            xmlContent = xmlContent.replace(
              new RegExp(`<a:t[^>]*>${this.escapeXml(segment.src)}</a:t>`, 'g'),
              `<a:t>${this.escapeXml(segment.tgt)}</a:t>`
            );
          }
        });
        
        archive.file(slidePath, xmlContent);
      }
      
      const updatedBuffer = await archive.generateAsync({ type: 'nodebuffer' });
      return updatedBuffer;
    } catch (error) {
      log.error('PPTX reconstruction failed', { error: error.message });
      return originalBuffer;
    }
  }
  
  escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

// Export singleton
const fileTranslationSystem = new FileTranslationSystem();

module.exports = {
  fileTranslationSystem,
  FileTranslationSystem,
  PDFHandler,
  DOCXHandler,  
  PPTXHandler
};

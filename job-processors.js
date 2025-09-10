// job-processors.js - Job processors for different types of translation work
const gemini = require('./gemini');
const log = require('./logger');
const { recordMetrics } = require('./metrics');

// Using Gemini Flash; no OpenAI

/**
 * Long translation job processor - for large documents/files
 */
async function processLongTranslationJob(job) {
  const startTime = Date.now();
  const { text, mode, targetLanguage, subStyle, rephrase, injections, userId, requestId } = job.data;

  try {
    log.info('Processing long translation job', { 
      jobId: job.id, 
      textLength: text.length, 
      mode, 
      targetLanguage, 
      userId 
    });

    await job.updateProgress(10);

    // Use Gemini Flash

    // Split large text into chunks if needed
    const maxChunkSize = Number(process.env.LONG_JOB_CHUNK_SIZE || 15000);
    const chunks = text.length > maxChunkSize ? chunkText(text, maxChunkSize) : [text];
    
    await job.updateProgress(20);

    const results = [];
    let processedChunks = 0;

    for (const chunk of chunks) {
      try {
        const prompt = buildPrompt({ text: chunk, mode, subStyle, targetLanguage, rephrase, injections });
        
        const out = await gemini.generateContent({ text: prompt, system: 'You are an expert localization and translation assistant.', model: process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash' });
        const raw = String(out?.text || '').trim();
        const result = extractResultTagged(raw) || '(no output)';
        const sanitized = sanitizeWithSource(result, chunk, targetLanguage);
        
        results.push(sanitized);
        processedChunks++;

        // Update progress based on chunks processed
        const progress = 20 + (processedChunks / chunks.length) * 70; // 20-90%
        await job.updateProgress(Math.round(progress));

        // Add small delay between chunks to prevent overwhelming the API
        if (processedChunks < chunks.length) {
          await sleep(Number(process.env.CHUNK_DELAY_MS || 100));
        }

      } catch (error) {
        log.error('Error processing chunk in long translation job', { 
          jobId: job.id, 
          chunkIndex: processedChunks, 
          error: error.message 
        });
        
        // If circuit breaker fallback was triggered, use that result
        if (error.result && error.result.fallback) {
          results.push('Translation temporarily unavailable for this section.');
        } else {
          throw error; // Re-throw other errors to trigger job retry
        }
      }
    }

    await job.updateProgress(95);

    const finalResult = results.join(' ');
    const duration = Date.now() - startTime;

    // Record metrics
    recordMetrics.translation('long', mode, targetLanguage, 'unknown', true, text.length + finalResult.length);
    recordMetrics.jobDuration('translation-long', 'translate', duration);

    await job.updateProgress(100);

    log.info('Long translation job completed', { 
      jobId: job.id, 
      duration, 
      inputLength: text.length, 
      outputLength: finalResult.length 
    });

    return {
      result: finalResult,
      metadata: {
        duration,
        chunksProcessed: chunks.length,
        inputLength: text.length,
        outputLength: finalResult.length,
        mode,
        targetLanguage
      }
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    log.error('Long translation job failed', { 
      jobId: job.id, 
      error: error.message, 
      duration 
    });
    
    recordMetrics.translation('long', mode, targetLanguage, 'unknown', false, text.length);
    recordMetrics.jobDuration('translation-long', 'translate', duration);
    
    throw error;
  }
}

/**
 * File processing job processor - for document translation
 */
async function processFileTranslationJob(job) {
  const startTime = Date.now();
  const { 
    filePath, 
    fileType, 
    mode, 
    targetLanguage, 
    subStyle, 
    rephrase, 
    injections, 
    userId, 
    requestId 
  } = job.data;

  try {
    log.info('Processing file translation job', { 
      jobId: job.id, 
      filePath, 
      fileType, 
      mode, 
      targetLanguage, 
      userId 
    });

    await job.updateProgress(5);

    // File processing logic would go here (extract text from file)
    // This is a placeholder for actual file processing
    let extractedText = '';
    
    switch (fileType.toLowerCase()) {
      case 'txt':
        extractedText = await extractTextFromTxt(filePath);
        break;
      case 'docx':
        extractedText = await extractTextFromDocx(filePath);
        break;
      case 'pdf':
        extractedText = await extractTextFromPdf(filePath);
        break;
      case 'srt':
        extractedText = await extractTextFromSrt(filePath);
        break;
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }

    await job.updateProgress(20);

    // Use the long translation processor for the extracted text
    const translationJobData = {
      text: extractedText,
      mode,
      targetLanguage,
      subStyle,
      rephrase,
      injections,
      userId,
      requestId
    };

    // Create a mock job object for the translation processor
    const mockJob = {
      id: `${job.id}-translation`,
      data: translationJobData,
      updateProgress: async (progress) => {
        // Map translation progress to file job progress (20-90%)
        const mappedProgress = 20 + (progress / 100) * 70;
        await job.updateProgress(Math.round(mappedProgress));
      }
    };

    const translationResult = await processLongTranslationJob(mockJob);

    await job.updateProgress(95);

    // Generate output file based on original format
    const outputFilePath = await generateOutputFile(filePath, fileType, translationResult.result, targetLanguage);

    await job.updateProgress(100);

    const duration = Date.now() - startTime;
    recordMetrics.jobDuration('file-processing', fileType, duration);

    log.info('File translation job completed', { 
      jobId: job.id, 
      duration, 
      inputFile: filePath, 
      outputFile: outputFilePath 
    });

    return {
      outputFilePath,
      originalFilePath: filePath,
      translationResult: translationResult.result,
      metadata: {
        ...translationResult.metadata,
        duration,
        fileType,
        outputFilePath
      }
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    log.error('File translation job failed', { 
      jobId: job.id, 
      error: error.message, 
      filePath, 
      duration 
    });
    
    recordMetrics.jobDuration('file-processing', fileType || 'unknown', duration);
    
    throw error;
  }
}

/**
 * Batch translation job processor - for high-throughput batch processing
 */
async function processBatchTranslationJob(job) {
  const startTime = Date.now();
  const { items, mode, targetLanguage, subStyle, rephrase, injections, userId, requestId } = job.data;

  try {
    log.info('Processing batch translation job', { 
      jobId: job.id, 
      itemCount: items.length, 
      mode, 
      targetLanguage, 
      userId 
    });

    await job.updateProgress(10);

    // Use Gemini Flash for batch jobs

    // Use existing batch processing logic but with job progress updates
    const chunks = chunkByTokenBudget(items, {
      maxTokensPerRequest: Number(process.env.BATCH_TOKENS || 7000),
      overheadTokens: 1200,
      outputFactor: 1.15,
      maxItemsPerChunk: 250
    });

    await job.updateProgress(20);

    const results = [];
    let processedChunks = 0;

    for (const chunk of chunks) {
      try {
        const prompt = buildBatchPrompt({
          items: chunk,
          mode,
          subStyle,
          targetLanguage,
          rephrase,
          injections
        });

        const out = await gemini.generateContent({ text: prompt, system: 'You are an expert localization and translation assistant.', model: process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash', timeoutMs: Number(process.env.GEMINI_TIMEOUT || 300000) });
        const raw = String(out?.text || '').trim();

        let arr = parseJsonArrayStrict(raw, chunk.length);

        // Final sanitation per line with source awareness
        for (let i = 0; i < arr.length; i++) {
          arr[i] = sanitizeWithSource(arr[i] || '', chunk[i] || '', targetLanguage);
        }

        results.push(...arr);
        processedChunks++;

        // Update progress based on chunks processed
        const progress = 20 + (processedChunks / chunks.length) * 70; // 20-90%
        await job.updateProgress(Math.round(progress));

        // Add delay between chunks for rate limiting
        if (processedChunks < chunks.length) {
          await sleep(Number(process.env.BATCH_CHUNK_DELAY_MS || 200));
        }

      } catch (error) {
        log.error('Error processing chunk in batch job', { 
          jobId: job.id, 
          chunkIndex: processedChunks, 
          error: error.message 
        });
        
        // If circuit breaker fallback was triggered, use fallback results
        if (error.result && error.result.fallback) {
          // Add fallback results for this chunk
          const fallbackResults = chunk.map(() => 'Translation temporarily unavailable.');
          results.push(...fallbackResults);
        } else {
          throw error; // Re-throw other errors to trigger job retry
        }
      }
    }

    await job.updateProgress(95);

    const duration = Date.now() - startTime;
    const totalChars = items.join('').length + results.join('').length;

    // Record metrics
    recordMetrics.translation('batch', mode, targetLanguage, 'unknown', true, totalChars);
    recordMetrics.jobDuration('batch-translation', 'batch', duration);

    await job.updateProgress(100);

    log.info('Batch translation job completed', { 
      jobId: job.id, 
      duration, 
      itemCount: items.length, 
      resultCount: results.length 
    });

    return {
      items: results,
      metadata: {
        duration,
        itemsProcessed: items.length,
        totalCharacters: totalChars,
        chunksProcessed: processedChunks,
        mode,
        targetLanguage
      }
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    log.error('Batch translation job failed', { 
      jobId: job.id, 
      error: error.message, 
      itemCount: items.length, 
      duration 
    });
    
    recordMetrics.translation('batch', mode, targetLanguage, 'unknown', false, items.join('').length);
    recordMetrics.jobDuration('batch-translation', 'batch', duration);
    
    throw error;
  }
}

// Helper functions (these would need to be implemented or imported from existing code)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkText(text, maxSize) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + maxSize;
    
    // Try to break at sentence boundaries
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      
      if (breakPoint > start + maxSize * 0.5) { // Don't make chunks too small
        end = breakPoint + 1;
      }
    }
    
    chunks.push(text.slice(start, end));
    start = end;
  }
  
  return chunks;
}

// These functions would need to be implemented or imported from the main server.js
// For now, creating stubs that would need to be replaced with actual implementations

function buildPrompt(options) {
  // This should use the existing buildPrompt function from server.js
  return `Translate the following text into ${options.targetLanguage} using ${options.mode} style: ${options.text}`;
}

function buildBatchPrompt(options) {
  // This should use the existing buildBatchPrompt function from server.js
  return `Translate the following items into ${options.targetLanguage}: ${JSON.stringify(options.items)}`;
}

function pickTemperature(mode, subStyle, rephrase) {
  // This should use the existing pickTemperature function from server.js
  return mode === 'creative' ? 0.8 : 0.3;
}

function extractResultTagged(raw) {
  // This should use the existing extractResultTagged function from server.js
  const match = raw.match(/<result>([\s\S]*?)<\/result>/);
  return match ? match[1].trim() : raw;
}

function sanitizeWithSource(result, source, targetLanguage) {
  // This should use the existing sanitizeWithSource function from server.js
  return result.trim();
}

function parseJsonArrayStrict(raw, expectedLen) {
  // This should use the existing parseJsonArrayStrict function from server.js
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === expectedLen) {
      return parsed.map(x => String(x));
    }
  } catch (e) {
    // Fallback parsing logic
  }
  return new Array(expectedLen).fill('Translation unavailable');
}

function chunkByTokenBudget(items, options) {
  // This should use the existing chunkByTokenBudget function from server.js
  const chunks = [];
  const chunkSize = Math.ceil(items.length / 10); // Simple chunking for now
  
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  
  return chunks;
}

// File processing stubs - these would need proper implementation
async function extractTextFromTxt(filePath) {
  const fs = require('fs').promises;
  return await fs.readFile(filePath, 'utf8');
}

async function extractTextFromDocx(filePath) {
  // Use mammoth library - implementation needed
  return 'DOCX content extraction not implemented';
}

async function extractTextFromPdf(filePath) {
  // Use pdf-parse library - implementation needed
  return 'PDF content extraction not implemented';
}

async function extractTextFromSrt(filePath) {
  // Use srt-parser-2 library - implementation needed
  return 'SRT content extraction not implemented';
}

async function generateOutputFile(inputPath, fileType, translatedText, targetLanguage) {
  // Generate output file based on type - implementation needed
  const outputPath = inputPath.replace(/\.[^.]+$/, `_${targetLanguage}.${fileType}`);
  
  const fs = require('fs').promises;
  await fs.writeFile(outputPath, translatedText, 'utf8');
  
  return outputPath;
}

module.exports = {
  processLongTranslationJob,
  processFileTranslationJob,
  processBatchTranslationJob
};


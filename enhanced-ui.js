// enhanced-ui.js - Advanced UI/UX enhancements for the frontend
// This file contains JavaScript to be included in the frontend for enhanced user experience

/**
 * Enhanced Drag and Drop Manager
 */
class EnhancedDragDropManager {
  constructor() {
    this.isInitialized = false;
    this.dragCounter = 0;
    this.allowedTypes = ['.txt', '.docx', '.pdf', '.srt', '.pptx'];
    this.maxFileSize = 52428800; // 50MB in bytes  
    this.uploadQueue = [];
    this.uploadInProgress = false;
    this.currentFileJob = null;
    this.progressSource = null;
  }

  /**
   * Initialize enhanced drag and drop
   */
  init() {
    if (this.isInitialized) return;

    this.setupDragAndDrop();
    this.setupProgressTracking();
    this.setupFileValidation();
    this.setupUploadQueue();
    
    this.isInitialized = true;
    console.log('Enhanced drag and drop initialized');
  }

  /**
   * Setup advanced drag and drop functionality
   */
  setupDragAndDrop() {
    const dropzone = document.getElementById('dropzone');
    if (!dropzone) return;

    // Create enhanced visual feedback
    this.createDropIndicator();
    this.createProgressOverlay();

    // Enhanced drag events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Drag enter/leave counter for nested elements
    dropzone.addEventListener('dragenter', (e) => {
      this.dragCounter++;
      this.showDropIndicator();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', (e) => {
      this.dragCounter--;
      if (this.dragCounter === 0) {
        this.hideDropIndicator();
        dropzone.classList.remove('drag-over');
      }
    });

    // Enhanced drop handling
    dropzone.addEventListener('drop', (e) => {
      this.dragCounter = 0;
      this.hideDropIndicator();
      dropzone.classList.remove('drag-over');
      
      const files = Array.from(e.dataTransfer.files);
      this.handleMultipleFiles(files);
    });

    // Paste support for files
    document.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData.items);
      const files = items
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter(file => file);
      
      if (files.length > 0) {
        this.handleMultipleFiles(files);
      }
    });
  }

  /**
   * Handle multiple file uploads - enhanced for file translation
   */
  async handleMultipleFiles(files) {
    if (files.length === 0) return;
    
    // Validate files first
    const { validFiles, invalidFiles } = this.validateFiles(files);
    
    if (invalidFiles.length > 0) {
      this.showValidationErrors(invalidFiles);
    }
    
    if (validFiles.length === 0) return;
    
    // Check for file types that support advanced translation
    const fileTranslationTypes = ['.pdf', '.docx', '.pptx'];
    const advancedFiles = validFiles.filter(file => 
      fileTranslationTypes.includes(this.getFileExtension(file.name))
    );
    
    // If there are advanced files, use file translation system
    if (advancedFiles.length > 0) {
      for (const file of advancedFiles) {
        await this.handleFileTranslation(file);
      }
    }
    
    // Handle remaining files with legacy system
    const legacyFiles = validFiles.filter(file => 
      !fileTranslationTypes.includes(this.getFileExtension(file.name))
    );
    
    if (legacyFiles.length > 0) {
      // Add to upload queue for text extraction
      for (const file of legacyFiles) {
        this.uploadQueue.push({
          file,
          id: Date.now() + Math.random(),
          status: 'queued', 
          progress: 0
        });
      }
      
      // Start processing queue
      this.processFiles(legacyFiles);
    }
  }

  /**
   * Handle file translation for PDF, DOCX, PPTX files
   */
  async handleFileTranslation(file) {
    try {
      // Check if user has selected target language and style
      const targetLanguage = this.getCurrentTargetLanguage();
      const mode = this.getCurrentTranslationMode();
      const subStyle = this.getCurrentSubStyle();
      
      if (!targetLanguage) {
        this.showToast('Please select a target language first');
        this.pulseElement(document.getElementById('langButtonsRow'));
        return;
      }
      
      if (!mode) {
        this.showToast('Please select a translation style first');
        this.pulseElement(document.getElementById('styleButtonsRow'));
        return;
      }
      
      // Show progress bar
      const progressBar = this.showFileTranslationProgress(file.name);
      
      // Create form data
      const formData = new FormData();
      formData.append('file', file);
      formData.append('srcLang', ''); // Auto-detect
      formData.append('tgtLang', targetLanguage);
      formData.append('mode', mode);
      formData.append('subStyle', subStyle || 'general');
      formData.append('injections', this.getCurrentInjections());
      
      // Get auth headers
      const headers = await this.getAuthHeaders();
      
      // Start translation job
      const response = await fetch('/api/file-jobs', {
        method: 'POST',
        headers,
        body: formData
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start translation');
      }
      
      const result = await response.json();
      this.currentFileJob = result.jobId;
      
      // Start progress tracking
      this.trackFileTranslationProgress(result.jobId, file.name);
      
    } catch (error) {
      console.error('File translation failed:', error);
      this.showToast('Failed to start file translation: ' + error.message);
      this.hideFileTranslationProgress();
    }
  }

  /**
   * Get current target language from UI
   */
  getCurrentTargetLanguage() {
    const activeBtn = document.querySelector('.lang-btn.active');
    return activeBtn ? activeBtn.dataset.lang : null;
  }

  /**
   * Get current translation mode from UI  
   */
  getCurrentTranslationMode() {
    const activeBtn = document.querySelector('.style-btn.active');
    return activeBtn ? activeBtn.dataset.mode : null;
  }

  /**
   * Get current substyle from UI
   */
  getCurrentSubStyle() {
    const subPanel = document.getElementById('substylePanel');
    const activeChip = subPanel?.querySelector('.substyle-chip.active');
    return activeChip ? activeChip.dataset.sub : null;
  }

  /**
   * Get current brand injections
   */
  getCurrentInjections() {
    // This would integrate with the brand kit system if active
    return '';
  }

  /**
   * Show file translation progress
   */
  showFileTranslationProgress(filename) {
    const progressBar = document.querySelector('.upload-progress-bar');
    if (!progressBar) return null;
    
    // Set up progress bar for file translation
    progressBar.classList.add('show', 'is-busy');
    const progressContent = progressBar.querySelector('.progress-content');
    if (progressContent) {
      progressContent.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:600;font-size:14px;">Translating ${filename}</div>
            <div style="color:var(--muted);font-size:12px;" id="fileProgressStatus">Initializing...</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="fileProgressPercent" style="font-size:13px;font-weight:600;">0%</span>
            <button class="btn" id="fileProgressCancelBtn" style="font-size:12px;padding:4px 8px;border-color:var(--border);">Cancel</button>
          </div>
        </div>
        <div style="background:#f0f0f3;border-radius:4px;height:6px;overflow:hidden;margin-top:8px;">
          <div id="fileProgressBar" style="background:var(--accent);height:100%;width:0%;transition:width 0.3s ease;"></div>
        </div>
      `;
      
      // Show file progress details
      const fileProgressDetails = document.getElementById('fileProgressDetails');
      if (fileProgressDetails) {
        fileProgressDetails.classList.add('show');
      }
    }
    
    return progressBar;
  }

  /**
   * Track file translation progress via SSE
   */
  trackFileTranslationProgress(jobId, filename) {
    // Close existing connection
    if (this.progressSource) {
      this.progressSource.close();
    }
    
    // Create SSE connection
    this.progressSource = new EventSource(`/api/file-jobs/${jobId}/events`);
    
    this.progressSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleProgressUpdate(data);
      } catch (error) {
        console.error('Progress event parse error:', error);
      }
    };
    
    this.progressSource.onerror = (error) => {
      console.error('Progress source error:', error);
      // Fallback to polling
      setTimeout(() => this.pollJobStatus(jobId), 2000);
    };
    
    // Set up cancel button
    const cancelBtn = document.getElementById('fileProgressCancelBtn');
    if (cancelBtn) {
      cancelBtn.onclick = () => this.cancelFileTranslation(jobId);
    }
  }

  /**
   * Handle progress updates
   */
  handleProgressUpdate(data) {
    if (data.type === 'progress') {
      this.updateFileProgress(data.pct, data.label, data.meta);
      
      // Update details if available
      if (data.meta) {
        this.updateFileProgressDetails(data.meta);
      }
    } else if (data.type === 'complete') {
      // Job completed, get final results
      if (this.currentFileJob) {
        this.fetchTranslationResult(this.currentFileJob);
      }
    }
  }

  /**
   * Update file progress display
   */
  updateFileProgress(percent, label, meta = {}) {
    const progressBar = document.getElementById('fileProgressBar');
    const progressStatus = document.getElementById('fileProgressStatus');
    const progressPercent = document.getElementById('fileProgressPercent');
    
    if (progressBar) progressBar.style.width = percent + '%';
    if (progressStatus) progressStatus.textContent = label;
    if (progressPercent) progressPercent.textContent = percent + '%';
  }

  /**
   * Update file progress details
   */
  updateFileProgressDetails(meta) {
    if (meta.pages) {
      const pagesEl = document.getElementById('fileProgressPages');
      if (pagesEl) pagesEl.textContent = meta.pages;
    }
    if (meta.segments) {
      const segmentsEl = document.getElementById('fileProgressSegments');
      if (segmentsEl) segmentsEl.textContent = meta.segments;
    }
    if (meta.charCount) {
      const charsEl = document.getElementById('fileProgressChars'); 
      if (charsEl) charsEl.textContent = meta.charCount.toLocaleString();
    }
  }

  /**
   * Fetch translation result and show download
   */
  async fetchTranslationResult(jobId) {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`/api/file-jobs/${jobId}`, { headers });
      
      if (!response.ok) throw new Error('Failed to fetch result');
      
      const job = await response.json();
      
      if (job.status === 'done') {
        this.showTranslationComplete(job);
      } else if (job.status === 'error') {
        this.showToast('Translation failed: ' + (job.error?.message || 'Unknown error'));
        this.hideFileTranslationProgress();
      }
    } catch (error) {
      console.error('Failed to fetch translation result:', error);
      this.showToast('Failed to get translation result');
      this.hideFileTranslationProgress();
    }
  }

  /**
   * Show translation complete with download option
   */
  showTranslationComplete(job) {
    const progressBar = document.querySelector('.upload-progress-bar');
    if (!progressBar) return;
    
    progressBar.classList.remove('is-busy');
    const progressContent = progressBar.querySelector('.progress-content');
    if (progressContent) {
      progressContent.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:600;font-size:14px;color:green;">✓ Translation Complete</div>
            <div style="color:var(--muted);font-size:12px;">${job.original_filename}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn" id="fileDownloadBtn" style="font-size:12px;padding:4px 12px;background:var(--accent);color:white;border-color:var(--accent);">Download</button>
            <button class="btn" style="font-size:12px;padding:4px 8px;border-color:var(--border);" onclick="this.closest('.upload-progress-bar').classList.remove('show')">Close</button>
          </div>
        </div>
      `;
      
      // Set up download button
      const downloadBtn = document.getElementById('fileDownloadBtn');
      if (downloadBtn) {
        downloadBtn.onclick = () => this.downloadTranslatedFile(job.id);
      }
      
      // Auto-hide progress bar after a delay
      setTimeout(() => {
        progressBar.classList.remove('show');
      }, 10000); // Hide after 10 seconds
      
      // Show quality summary in progress details
      if (job.fit_report) {
        const qualityEl = document.getElementById('fileProgressQuality');
        if (qualityEl) {
          const quality = job.fit_report.passesThreshold ? 'Good' : 'Needs Review';
          const fitPercent = (job.fit_report.overallFitRatio * 100).toFixed(1);
          qualityEl.innerHTML = `${quality} (${fitPercent}% fit)`;
          qualityEl.style.color = job.fit_report.passesThreshold ? 'green' : 'orange';
        }
      }
    }
  }

  /**
   * Download translated file
   */
  async downloadTranslatedFile(jobId) {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`/api/file-jobs/${jobId}/result`, { headers });
      
      if (!response.ok) throw new Error('Failed to get download URL');
      
      const result = await response.json();
      
      // Create download link
      const a = document.createElement('a');
      a.href = result.downloadUrl;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      this.showToast('Download started');
      
    } catch (error) {
      console.error('Download failed:', error);
      this.showToast('Failed to download file');
    }
  }

  /**
   * Cancel file translation
   */
  async cancelFileTranslation(jobId) {
    try {
      const headers = await this.getAuthHeaders();
      await fetch(`/api/file-jobs/${jobId}`, {
        method: 'DELETE',
        headers
      });
      
      if (this.progressSource) {
        this.progressSource.close();
        this.progressSource = null;
      }
      
      this.hideFileTranslationProgress();
      this.showToast('Translation cancelled');
      
    } catch (error) {
      console.error('Cancel failed:', error);
      this.showToast('Failed to cancel translation');
    }
  }

  /**
   * Hide file translation progress
   */
  hideFileTranslationProgress() {
    const progressBar = document.querySelector('.upload-progress-bar');
    if (progressBar) {
      progressBar.classList.remove('show', 'is-busy');
    }
    
    const fileProgressDetails = document.getElementById('fileProgressDetails');
    if (fileProgressDetails) {
      fileProgressDetails.classList.remove('show');
    }
    
    this.currentFileJob = null;
  }

  /**
   * Get file extension
   */
  getFileExtension(filename) {
    return '.' + filename.split('.').pop().toLowerCase();
  }

  /**
   * Get authentication headers
   */
  async getAuthHeaders() {
    const headers = {};
    
    try {
      // Try to get user from localStorage first
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      
      if (user.isGuest) {
        headers['X-Guest-ID'] = localStorage.getItem('guestId');
      } else {
        // Try to get Supabase session token
        const authToken = localStorage.getItem('authToken');
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        } else if (window.supabase) {
          // Try to get current Supabase session
          const supabaseSession = await window.supabase.auth.getSession();
          if (supabaseSession?.data?.session?.access_token) {
            headers['Authorization'] = `Bearer ${supabaseSession.data.session.access_token}`;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to get auth headers:', e);
    }
    
    return headers;
  }

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    // Use existing toast system
    if (window.showToast) {
      window.showToast(message);
    } else {
      console.log('Toast:', message);
    }
  }

  /**
   * Pulse element for attention
   */
  pulseElement(element) {
    if (window.pulse) {
      window.pulse(element);
    } else if (element) {
      element.style.animation = 'pulse 0.5s ease-in-out';
      setTimeout(() => {
        element.style.animation = '';
      }, 500);
    }
  }

  /**
   * Create visual drop indicator
   */
  createDropIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'drop-indicator';
    indicator.className = 'drop-indicator';
    indicator.innerHTML = `
      <div class="drop-indicator-content">
        <div class="drop-icon">📁</div>
        <div class="drop-text">Drop files here to translate</div>
        <div class="drop-types">Supports: ${this.allowedTypes.join(', ')}</div>
      </div>
    `;
    
    // Add CSS styles
    const style = document.createElement('style');
    style.textContent = `
      .drop-indicator {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(59, 130, 246, 0.1);
        backdrop-filter: blur(4px);
        display: none;
        z-index: 10000;
        align-items: center;
        justify-content: center;
      }
      
      .drop-indicator.show {
        display: flex;
      }
      
      .drop-indicator-content {
        background: white;
        border: 3px dashed #3b82f6;
        border-radius: 12px;
        padding: 48px;
        text-align: center;
        max-width: 400px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      }
      
      .drop-icon {
        font-size: 48px;
        margin-bottom: 16px;
      }
      
      .drop-text {
        font-size: 18px;
        font-weight: 600;
        margin-bottom: 8px;
        color: #1f2937;
      }
      
      .drop-types {
        font-size: 14px;
        color: #6b7280;
      }
      
      .drag-over {
        transform: scale(1.02);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
        transition: all 0.2s ease;
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(indicator);
    this.dropIndicator = indicator;
  }

  /**
   * Create progress overlay
   */
  createProgressOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'upload-progress-overlay';
    overlay.className = 'upload-progress-overlay';
    overlay.innerHTML = `
      <div class="progress-content">
        <div class="progress-header">
          <h3>Uploading Files</h3>
          <button class="progress-close">×</button>
        </div>
        <div class="progress-list"></div>
        <div class="progress-summary">
          <span class="progress-current">0</span> of <span class="progress-total">0</span> files uploaded
        </div>
      </div>
    `;

    // Add CSS for progress overlay
    const style = document.createElement('style');
    style.textContent = `
      .upload-progress-overlay {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: white;
        border-radius: 12px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        border: 1px solid #e5e7eb;
        min-width: 320px;
        max-width: 400px;
        display: none;
        z-index: 9999;
      }
      
      .upload-progress-overlay.show {
        display: block;
        animation: slideIn 0.3s ease-out;
      }
      
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      
      .progress-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
        border-bottom: 1px solid #e5e7eb;
      }
      
      .progress-header h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
      }
      
      .progress-close {
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
        color: #6b7280;
        padding: 0;
        width: 24px;
        height: 24px;
      }
      
      .progress-list {
        max-height: 200px;
        overflow-y: auto;
        padding: 8px;
      }
      
      .progress-item {
        display: flex;
        align-items: center;
        padding: 8px;
        border-radius: 6px;
        margin-bottom: 4px;
      }
      
      .progress-item.uploading {
        background: #f3f4f6;
      }
      
      .progress-item.success {
        background: #d1fae5;
      }
      
      .progress-item.error {
        background: #fee2e2;
      }
      
      .progress-filename {
        flex: 1;
        font-size: 14px;
        truncate: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }
      
      .progress-status {
        font-size: 12px;
        margin-left: 8px;
      }
      
      .progress-bar {
        width: 100%;
        height: 4px;
        background: #e5e7eb;
        border-radius: 2px;
        overflow: hidden;
        margin-top: 4px;
      }
      
      .progress-fill {
        height: 100%;
        background: #3b82f6;
        width: 0%;
        transition: width 0.3s ease;
      }
      
      .progress-summary {
        padding: 12px 16px;
        border-top: 1px solid #e5e7eb;
        font-size: 14px;
        text-align: center;
        color: #6b7280;
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    this.progressOverlay = overlay;

    // Setup close button
    overlay.querySelector('.progress-close').addEventListener('click', () => {
      overlay.classList.remove('show');
    });
  }

  /**
   * Show drop indicator
   */
  showDropIndicator() {
    if (this.dropIndicator) {
      this.dropIndicator.classList.add('show');
    }
  }

  /**
   * Hide drop indicator
   */
  hideDropIndicator() {
    if (this.dropIndicator) {
      this.dropIndicator.classList.remove('show');
    }
  }

  /**
   * Handle multiple files with enhanced validation
   */
  async handleMultipleFiles(files) {
    if (files.length === 0) return;

    // Validate files
    const validFiles = [];
    const invalidFiles = [];

    for (const file of files) {
      const validation = this.validateFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        invalidFiles.push({ file, errors: validation.errors });
      }
    }

    // Show validation errors
    if (invalidFiles.length > 0) {
      this.showValidationErrors(invalidFiles);
    }

    // Process valid files
    if (validFiles.length > 0) {
      await this.processFiles(validFiles);
    }
  }

  /**
   * Validate individual file
   */
  validateFile(file) {
    const errors = [];
    
    // Check file size
    if (file.size > this.maxFileSize) {
      errors.push(`File too large (${this.formatFileSize(file.size)} > ${this.formatFileSize(this.maxFileSize)})`);
    }
    
    // Check file type
    const extension = '.' + file.name.split('.').pop().toLowerCase();
    if (!this.allowedTypes.includes(extension)) {
      errors.push(`Unsupported file type: ${extension}`);
    }
    
    // Check file name
    if (file.name.length > 255) {
      errors.push('File name too long');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Show validation errors to user
   */
  showValidationErrors(invalidFiles) {
    const errorMessages = invalidFiles.map(({ file, errors }) => 
      `${file.name}: ${errors.join(', ')}`
    ).join('\n');
    
    // Create toast notification
    this.showToast('File Validation Errors', errorMessages, 'error');
  }

  /**
   * Process valid files with progress tracking
   */
  async processFiles(files) {
    this.uploadQueue = files.map((file, index) => ({
      id: `upload_${Date.now()}_${index}`,
      file,
      status: 'pending',
      progress: 0,
      result: null,
      error: null
    }));

    this.showProgressOverlay();
    this.updateProgressSummary();

    // Process files sequentially to avoid overwhelming the server
    for (const uploadItem of this.uploadQueue) {
      await this.uploadSingleFile(uploadItem);
    }

    // Show completion notification
    const successCount = this.uploadQueue.filter(item => item.status === 'success').length;
    const errorCount = this.uploadQueue.filter(item => item.status === 'error').length;
    
    this.showToast(
      'Upload Complete',
      `${successCount} files uploaded successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
      errorCount > 0 ? 'warning' : 'success'
    );
  }

  /**
   * Upload single file with progress tracking
   */
  async uploadSingleFile(uploadItem) {
    try {
      uploadItem.status = 'uploading';
      this.updateProgressItem(uploadItem);

      const formData = new FormData();
      formData.append('file', uploadItem.file);

      // Create XMLHttpRequest for progress tracking
      const xhr = new XMLHttpRequest();
      
      // Progress tracking
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          uploadItem.progress = Math.round((e.loaded / e.total) * 100);
          this.updateProgressItem(uploadItem);
        }
      });

      // Upload promise
      const uploadPromise = new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              resolve(response);
            } catch (parseError) {
              reject(new Error('Invalid response format'));
            }
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
          }
        };
        
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timeout'));
      });

      xhr.timeout = 300000; // 5 minutes timeout
      xhr.open('POST', '/api/upload');
      
      // Add authentication headers if available
      const token = localStorage.getItem('authToken');
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }

      xhr.send(formData);

      const result = await uploadPromise;
      
      uploadItem.status = 'success';
      uploadItem.progress = 100;
      uploadItem.result = result;
      
      this.updateProgressItem(uploadItem);
      
      // Add to file tabs if successful
      if (result.fileId) {
        this.addFileTab(uploadItem.file.name, result.fileId, result);
      } else if (result.text) {
        // Legacy text extraction result
        this.addTextTab(uploadItem.file.name, result.text, result);
      }

    } catch (error) {
      uploadItem.status = 'error';
      uploadItem.error = error.message;
      this.updateProgressItem(uploadItem);
      
      console.error('File upload failed', { fileName: uploadItem.file.name, error: error.message });
    } finally {
      this.updateProgressSummary();
    }
  }

  /**
   * Create drop indicator element
   */
  createDropIndicator() {
    // Implementation for visual drop indicator
    const indicator = document.createElement('div');
    indicator.className = 'enhanced-drop-indicator';
    // ... styling and setup
  }

  /**
   * Show progress overlay
   */
  showProgressOverlay() {
    if (this.progressOverlay) {
      this.progressOverlay.classList.add('show');
      this.updateProgressList();
    }
  }

  /**
   * Update progress list
   */
  updateProgressList() {
    const progressList = this.progressOverlay?.querySelector('.progress-list');
    if (!progressList) return;

    progressList.innerHTML = '';
    
    for (const item of this.uploadQueue) {
      const progressItem = document.createElement('div');
      progressItem.className = `progress-item ${item.status}`;
      progressItem.innerHTML = `
        <div class="progress-filename">${item.file.name}</div>
        <div class="progress-status">${this.getStatusText(item)}</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${item.progress}%"></div>
        </div>
      `;
      
      progressList.appendChild(progressItem);
    }
  }

  /**
   * Update individual progress item
   */
  updateProgressItem(uploadItem) {
    this.updateProgressList();
  }

  /**
   * Update progress summary
   */
  updateProgressSummary() {
    const currentSpan = this.progressOverlay?.querySelector('.progress-current');
    const totalSpan = this.progressOverlay?.querySelector('.progress-total');
    
    if (currentSpan && totalSpan) {
      const completedCount = this.uploadQueue.filter(item => 
        item.status === 'success' || item.status === 'error'
      ).length;
      
      currentSpan.textContent = completedCount;
      totalSpan.textContent = this.uploadQueue.length;
    }
  }

  /**
   * Get status text for upload item
   */
  getStatusText(item) {
    switch (item.status) {
      case 'pending': return 'Waiting...';
      case 'uploading': return `${item.progress}%`;
      case 'success': return '✓ Done';
      case 'error': return `✗ ${item.error}`;
      default: return '';
    }
  }

  /**
   * Add file tab to UI
   */
  addFileTab(fileName, fileId, uploadResult) {
    // This would integrate with the existing tab system
    const tabData = {
      id: fileId,
      label: fileName,
      type: 'file',
      content: uploadResult.extractedText || '',
      metadata: uploadResult
    };
    
    // Call existing tab management function
    if (window.addTab) {
      window.addTab(tabData);
    }
  }

  /**
   * Show toast notification
   */
  showToast(title, message, type = 'info') {
    const tone = type || 'info';
    const hasMessage = arguments.length > 1;
    const resolvedTitle = hasMessage ? (title != null ? String(title) : '') : '';
    const resolvedMessage = hasMessage ? (message != null ? String(message) : '') : (title != null ? String(title) : '');

    if (typeof window.showNotification === 'function') {
      window.showNotification(resolvedTitle, resolvedMessage, tone);
      return;
    }

    if (typeof window.showToast === 'function' && window.showToast !== this.showToast) {
      window.showToast(resolvedMessage, { title: resolvedTitle, tone });
      return;
    }

    console.log(`[${tone}] ${resolvedTitle || resolvedMessage}`);
  }

  /**
   * Format file size for display
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Setup file validation feedback
   */
  setupFileValidation() {
    const fileInput = document.getElementById('fileInput');
    if (!fileInput) return;

    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      this.handleMultipleFiles(files);
    });
  }

  /**
   * Setup upload queue management
   */
  setupUploadQueue() {
    // Queue management for handling multiple concurrent uploads
    this.maxConcurrentUploads = Number(localStorage.getItem('maxConcurrentUploads')) || 3;
  }
}

/**
 * Real-time Job Progress Tracker
 */
class JobProgressTracker {
  constructor() {
    this.socket = null;
    this.activeJobs = new Map();
    this.isConnected = false;
  }

  /**
   * Initialize WebSocket connection for job tracking
   */
  async init() {
    if (typeof io === 'undefined') {
      console.warn('Socket.IO not available - job progress tracking disabled');
      return;
    }

    try {
      // Connect to jobs namespace
      this.socket = io('/jobs', {
        transports: ['websocket', 'polling'],
        timeout: 20000,
        forceNew: false
      });

      this.setupSocketEvents();
      
    } catch (error) {
      console.error('Failed to initialize job progress tracker', error);
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  setupSocketEvents() {
    this.socket.on('connect', () => {
      this.isConnected = true;
      console.log('Job progress tracker connected');
      
      // Subscribe to all jobs for this user
      this.socket.emit('subscribe_all_jobs');
      
      // Restore active job subscriptions
      for (const jobId of this.activeJobs.keys()) {
        this.socket.emit('subscribe_job', jobId);
      }
    });

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      console.log('Job progress tracker disconnected:', reason);
    });

    this.socket.on('job_progress', (data) => {
      this.handleJobProgress(data);
    });

    this.socket.on('job_complete', (data) => {
      this.handleJobComplete(data);
    });

    this.socket.on('job_failed', (data) => {
      this.handleJobFailure(data);
    });

    this.socket.on('connect_error', (error) => {
      console.error('Job tracker connection error:', error);
    });
  }

  /**
   * Track new job
   */
  trackJob(jobId, jobName, metadata = {}) {
    if (!this.socket || !this.isConnected) {
      console.warn('Job tracker not connected - cannot track job', jobId);
      return;
    }

    this.activeJobs.set(jobId, {
      id: jobId,
      name: jobName,
      startTime: Date.now(),
      progress: 0,
      status: 'started',
      metadata
    });

    // Subscribe to job updates
    this.socket.emit('subscribe_job', jobId);
    
    // Show progress UI
    this.showJobProgress(jobId);
    
    console.log('Tracking job:', jobId);
  }

  /**
   * Handle job progress update
   */
  handleJobProgress(data) {
    const { jobId, progress, metadata } = data;
    const job = this.activeJobs.get(jobId);
    
    if (job) {
      job.progress = progress;
      job.lastUpdate = Date.now();
      job.metadata = { ...job.metadata, ...metadata };
      
      this.updateJobProgressUI(jobId, progress, metadata);
    }
  }

  /**
   * Handle job completion
   */
  handleJobComplete(data) {
    const { jobId, result, metadata } = data;
    const job = this.activeJobs.get(jobId);
    
    if (job) {
      job.status = 'completed';
      job.progress = 100;
      job.result = result;
      job.completedAt = Date.now();
      
      this.showJobComplete(jobId, result, metadata);
      this.cleanupJob(jobId);
    }
  }

  /**
   * Handle job failure
   */
  handleJobFailure(data) {
    const { jobId, error, metadata } = data;
    const job = this.activeJobs.get(jobId);
    
    if (job) {
      job.status = 'failed';
      job.error = error;
      job.failedAt = Date.now();
      
      this.showJobFailure(jobId, error, metadata);
      this.cleanupJob(jobId);
    }
  }

  /**
   * Show job progress in UI
   */
  showJobProgress(jobId) {
    // Create or update progress indicator in UI
    let progressContainer = document.getElementById('job-progress-container');
    
    if (!progressContainer) {
      progressContainer = document.createElement('div');
      progressContainer.id = 'job-progress-container';
      progressContainer.className = 'job-progress-container';
      
      // Add to UI
      const targetElement = document.querySelector('.card') || document.body;
      targetElement.appendChild(progressContainer);
    }

    const job = this.activeJobs.get(jobId);
    if (!job) return;

    const progressElement = document.createElement('div');
    progressElement.id = `job-progress-${jobId}`;
    progressElement.className = 'job-progress-item';
    progressElement.innerHTML = `
      <div class="job-info">
        <div class="job-name">${job.name}</div>
        <div class="job-status">Starting...</div>
      </div>
      <div class="job-progress-bar">
        <div class="job-progress-fill" style="width: 0%"></div>
      </div>
      <div class="job-percentage">0%</div>
    `;

    progressContainer.appendChild(progressElement);
  }

  /**
   * Update job progress UI
   */
  updateJobProgressUI(jobId, progress, metadata) {
    const progressElement = document.getElementById(`job-progress-${jobId}`);
    if (!progressElement) return;

    const fillElement = progressElement.querySelector('.job-progress-fill');
    const percentageElement = progressElement.querySelector('.job-percentage');
    const statusElement = progressElement.querySelector('.job-status');

    if (fillElement) fillElement.style.width = `${progress}%`;
    if (percentageElement) percentageElement.textContent = `${progress}%`;
    if (statusElement) {
      statusElement.textContent = metadata.status || `Processing... (${progress}%)`;
    }
  }

  /**
   * Show job completion
   */
  showJobComplete(jobId, result, metadata) {
    const progressElement = document.getElementById(`job-progress-${jobId}`);
    if (progressElement) {
      progressElement.classList.add('completed');
      
      const statusElement = progressElement.querySelector('.job-status');
      if (statusElement) {
        statusElement.textContent = '✓ Completed';
      }
      
      // Auto-remove after delay
      setTimeout(() => {
        progressElement.remove();
      }, 3000);
    }

    // Show result if available
    if (result && result.result) {
      this.displayTranslationResult(result.result, metadata);
    }
  }

  /**
   * Show job failure
   */
  showJobFailure(jobId, error, metadata) {
    const progressElement = document.getElementById(`job-progress-${jobId}`);
    if (progressElement) {
      progressElement.classList.add('failed');
      
      const statusElement = progressElement.querySelector('.job-status');
      if (statusElement) {
        statusElement.textContent = `✗ Failed: ${error}`;
      }
      
      // Auto-remove after longer delay for errors
      setTimeout(() => {
        progressElement.remove();
      }, 10000);
    }
  }

  /**
   * Display translation result
   */
  displayTranslationResult(result, metadata) {
    // Add result to the appropriate UI element
    const resultTextarea = document.getElementById('resultText');
    if (resultTextarea) {
      resultTextarea.value = result;
      
      // Trigger any existing result handlers
      if (window.handleTranslationResult) {
        window.handleTranslationResult(result, metadata);
      }
    }
  }

  /**
   * Cleanup completed job
   */
  cleanupJob(jobId) {
    setTimeout(() => {
      this.activeJobs.delete(jobId);
      
      if (this.socket && this.isConnected) {
        this.socket.emit('unsubscribe_job', jobId);
      }
    }, 5000); // Keep for 5 seconds after completion
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      activeJobs: this.activeJobs.size,
      socketId: this.socket?.id
    };
  }
}

// Global instances
const enhancedDragDrop = new EnhancedDragDropManager();
const jobProgressTracker = new JobProgressTracker();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    enhancedDragDrop.init();
    jobProgressTracker.init();
  });
} else {
  enhancedDragDrop.init();
  jobProgressTracker.init();
}

// Export for global access
window.enhancedDragDrop = enhancedDragDrop;
window.jobProgressTracker = jobProgressTracker;



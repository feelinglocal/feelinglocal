// localization-client.js - JavaScript client SDK for the frontend
class LocalizationClient {
  constructor(config = {}) {
    this.config = {
      baseUrl: config.baseUrl || '',
      apiKey: config.apiKey || '',
      token: config.token || localStorage.getItem('auth_token') || '',
      timeout: config.timeout || 30000,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000
    };
    this.requestId = '';
  }

  // Generate unique request ID for idempotency
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  }

  // Generate idempotency key
  generateIdempotencyKey() {
    return `idem_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  }

  // Create headers for requests
  createHeaders(idempotencyKey) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': this.generateRequestId(),
      'Cache-Control': 'no-store'
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    } else if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    // Attach a stable device ID for concurrency enforcement
    try {
      const k = 'device_id_v1';
      let did = localStorage.getItem(k);
      if (!did) { did = `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`; localStorage.setItem(k, did); }
      headers['X-Device-ID'] = did;
    } catch {}

    return headers;
  }

  // Sleep function for retry delays
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Check if error is retryable
  isRetryableError(status) {
    return status === 429 || status >= 500;
  }

  // Make HTTP request with retry logic
  async makeRequest(method, endpoint, body, idempotencyKey) {
    const url = `${this.config.baseUrl}${endpoint}`;
    const scopedKey = idempotencyKey ? `${method}:${endpoint}:${idempotencyKey}` : undefined;
    const headers = this.createHeaders(scopedKey);

    let lastError;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Store request ID from response
        this.requestId = response.headers.get('X-Request-Id') || '';

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          
          const apiError = new Error(errorData.error || `HTTP ${response.status}`);
          apiError.status = response.status;
          apiError.code = errorData.code;
          apiError.details = errorData;

          // Check if we should retry
          if (attempt < this.config.retryAttempts && this.isRetryableError(response.status)) {
            const delay = this.config.retryDelay * Math.pow(2, attempt); // Exponential backoff
            console.warn(`Request failed (attempt ${attempt + 1}/${this.config.retryAttempts + 1}), retrying in ${delay}ms:`, apiError.message);
            await this.sleep(delay);
            continue;
          }

          throw apiError;
        }

        const data = await response.json();
        return data;

      } catch (error) {
        lastError = error;

        // Don't retry network errors or timeouts
        if (error.name === 'AbortError' || !this.isRetryableError(error.status || 0)) {
          break;
        }

        if (attempt < this.config.retryAttempts) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          console.warn(`Request failed (attempt ${attempt + 1}/${this.config.retryAttempts + 1}), retrying in ${delay}ms:`, error.message);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  // Upload file
  async upload(file, filename) {
    try {
      const formData = new FormData();
      formData.append('file', file, filename || file.name || 'file');

      const headers = {};
      if (this.config.apiKey) {
        headers['X-API-Key'] = this.config.apiKey;
      } else if (this.config.token) {
        headers['Authorization'] = `Bearer ${this.config.token}`;
      }
      headers['X-Request-Id'] = this.generateRequestId();

      const response = await fetch(`${this.config.baseUrl}/api/upload`, {
        method: 'POST',
        headers,
        body: formData
      });

      this.requestId = response.headers.get('X-Request-Id') || '';

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { ok: false, error: errorData.error || `Upload failed: ${response.status}` };
      }

      const data = await response.json();
      return {
        ok: true,
        fileId: data.fileId,
        filename: data.filename
      };

    } catch (error) {
      return {
        ok: false,
        error: error.message || 'Upload failed'
      };
    }
  }

  // Single translation
  async translate(request) {
    try {
      const response = await this.makeRequest(
        'POST',
        '/api/translate',
        request,
        request.idempotencyKey || this.generateIdempotencyKey()
      );
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Translation failed'
      };
    }
  }

  // Batch translation
  async translateBatch(request) {
    try {
      const response = await this.makeRequest(
        'POST',
        '/api/translate-batch',
        request,
        request.idempotencyKey || this.generateIdempotencyKey()
      );
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Batch translation failed'
      };
    }
  }

  // Download all files as ZIP
  async downloadAllZip(files, zipname) {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/download-zip`, {
        method: 'POST',
        headers: this.createHeaders(),
        body: JSON.stringify({ files, zipname: zipname || 'localized' })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { error: errorData.error || `ZIP download failed: ${response.status}` };
      }

      const blob = await response.blob();
      const filename = `${zipname || 'localized'}.zip`;

      return {
        blob,
        filename
      };
    } catch (error) {
      return {
        error: error.message || 'ZIP download failed'
      };
    }
  }

  // Authentication
  async login(email, password) {
    try {
      const response = await this.makeRequest(
        'POST',
        '/auth/login',
        { email, password }
      );
      
      // Update token if login successful
      if (response.token) {
        this.config.token = response.token;
        localStorage.setItem('auth_token', response.token);
      }
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Login failed'
      };
    }
  }

  // Register
  async register(email, password, name) {
    try {
      const response = await this.makeRequest(
        'POST',
        '/auth/register',
        { email, password, name }
      );
      
      // Update token if registration successful
      if (response.token) {
        this.config.token = response.token;
        localStorage.setItem('auth_token', response.token);
      }
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Registration failed'
      };
    }
  }

  // Get current user
  async getCurrentUser() {
    try {
      const response = await this.makeRequest(
        'GET',
        '/auth/me'
      );
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Failed to get user info'
      };
    }
  }

  // Logout
  async logout() {
    try {
      await this.makeRequest(
        'POST',
        '/auth/logout'
      );
      
      this.config.token = '';
      localStorage.removeItem('auth_token');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Logout failed'
      };
    }
  }

  // Set authentication token
  setToken(token) {
    this.config.token = token;
    localStorage.setItem('auth_token', token);
  }

  // Set API key
  setApiKey(apiKey) {
    this.config.apiKey = apiKey;
  }

  // Get last request ID
  getLastRequestId() {
    return this.requestId;
  }

  // Check user tier and feature availability
  async checkTierFeatures() {
    try {
      const userResponse = await this.getCurrentUser();
      if (userResponse.error) {
        return {
          tier: 'free',
          features: {
            batchAllowed: false,
            zipDownloadAllowed: false,
            maxInputSize: 1000,
            maxRequestsPerDay: 50
          }
        };
      }

      const tier = userResponse.user?.tier || 'free';
      
      // Tier configurations (matching server-side)
      const tierFeatures = {
        free: {
          batchAllowed: false,
          zipDownloadAllowed: false,
          maxInputSize: 1000,
          maxRequestsPerDay: 50
        },
        pro: {
          batchAllowed: true,
          zipDownloadAllowed: true,
          maxInputSize: 10000,
          maxRequestsPerDay: 500
        },
        business: {
          batchAllowed: true,
          zipDownloadAllowed: true,
          maxInputSize: 50000,
          maxRequestsPerDay: 5000
        }
      };

      return {
        tier,
        features: tierFeatures[tier] || tierFeatures.free,
        user: userResponse.user
      };

    } catch (error) {
      return {
        tier: 'free',
        features: {
          batchAllowed: false,
          zipDownloadAllowed: false,
          maxInputSize: 1000,
          maxRequestsPerDay: 50
        },
        error: error.message
      };
    }
  }
}

// Create global client instance
window.localizationClient = new LocalizationClient();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocalizationClient;
}


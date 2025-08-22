// client-sdk.ts - TypeScript client SDK for localization app
export interface LocalizationClientConfig {
  baseUrl: string;
  apiKey?: string;
  token?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface UploadResponse {
  ok: boolean;
  fileId?: string;
  filename?: string;
  error?: string;
}

export interface TranslateRequest {
  text: string;
  mode: string;
  targetLanguage: string;
  subStyle?: string;
  rephrase?: boolean;
  idempotencyKey?: string;
}

export interface TranslateResponse {
  result?: string;
  error?: string;
}

export interface TranslateBatchRequest {
  items: string[];
  mode: string;
  targetLanguage: string;
  subStyle?: string;
  rephrase?: boolean;
  idempotencyKey?: string;
}

export interface TranslateBatchResponse {
  items?: string[];
  error?: string;
}

export interface DownloadResponse {
  blob?: Blob;
  filename?: string;
  error?: string;
}

export interface UserInfo {
  id: number;
  email: string;
  name: string;
  tier: string;
}

export interface AuthResponse {
  user?: UserInfo;
  token?: string;
  error?: string;
}

export interface ApiError extends Error {
  status?: number;
  code?: string;
  details?: any;
}

export class LocalizationClient {
  private config: Required<LocalizationClientConfig>;
  private requestId: string = '';

  constructor(config: LocalizationClientConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || '',
      token: config.token || '',
      timeout: config.timeout || 30000,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000
    };
  }

  // Generate unique request ID for idempotency
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  }

  // Create headers for requests
  private createHeaders(idempotencyKey?: string): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'X-Request-Id': this.generateRequestId()
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    } else if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return headers;
  }

  // Sleep function for retry delays
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Check if error is retryable
  private isRetryableError(status: number): boolean {
    return status === 429 || status >= 500;
  }

  // Make HTTP request with retry logic
  private async makeRequest<T>(
    method: string,
    endpoint: string,
    body?: any,
    idempotencyKey?: string
  ): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers = this.createHeaders(idempotencyKey);

    let lastError: ApiError;

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
          
          const apiError: ApiError = new Error(errorData.error || `HTTP ${response.status}`) as ApiError;
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
        return data as T;

      } catch (error) {
        lastError = error as ApiError;

        // Don't retry network errors or timeouts
        if (error.name === 'AbortError' || !this.isRetryableError(lastError.status || 0)) {
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
  async upload(file: File | Blob, filename?: string): Promise<UploadResponse> {
    try {
      const formData = new FormData();
      formData.append('file', file, filename || 'file');

      const headers: HeadersInit = {};
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
  async translate(request: TranslateRequest): Promise<TranslateResponse> {
    try {
      const response = await this.makeRequest<TranslateResponse>(
        'POST',
        '/api/translate',
        request,
        request.idempotencyKey
      );
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Translation failed'
      };
    }
  }

  // Batch translation
  async translateBatch(request: TranslateBatchRequest): Promise<TranslateBatchResponse> {
    try {
      const response = await this.makeRequest<TranslateBatchResponse>(
        'POST',
        '/api/translate-batch',
        request,
        request.idempotencyKey
      );
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Batch translation failed'
      };
    }
  }

  // Download file (placeholder for align functionality)
  async align(fileId: string): Promise<DownloadResponse> {
    try {
      // This would be implemented based on your align endpoint
      const response = await fetch(`${this.config.baseUrl}/api/align/${fileId}`, {
        method: 'GET',
        headers: this.createHeaders()
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { error: errorData.error || `Align failed: ${response.status}` };
      }

      const blob = await response.blob();
      const filename = response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'aligned.txt';

      return {
        blob,
        filename
      };
    } catch (error) {
      return {
        error: error.message || 'Align failed'
      };
    }
  }

  // Download single file
  async download(fileId: string): Promise<DownloadResponse> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/download/${fileId}`, {
        method: 'GET',
        headers: this.createHeaders()
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { error: errorData.error || `Download failed: ${response.status}` };
      }

      const blob = await response.blob();
      const filename = response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'download';

      return {
        blob,
        filename
      };
    } catch (error) {
      return {
        error: error.message || 'Download failed'
      };
    }
  }

  // Download all files as ZIP
  async downloadAllZip(files: any[], zipname?: string): Promise<DownloadResponse> {
    try {
      const response = await this.makeRequest<Blob>(
        'POST',
        '/api/download-zip',
        { files, zipname: zipname || 'localized' }
      );

      // For blob responses, we need to handle differently
      const blobResponse = await fetch(`${this.config.baseUrl}/api/download-zip`, {
        method: 'POST',
        headers: this.createHeaders(),
        body: JSON.stringify({ files, zipname: zipname || 'localized' })
      });

      if (!blobResponse.ok) {
        const errorData = await blobResponse.json().catch(() => ({}));
        return { error: errorData.error || `ZIP download failed: ${blobResponse.status}` };
      }

      const blob = await blobResponse.blob();
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
  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      const response = await this.makeRequest<AuthResponse>(
        'POST',
        '/auth/login',
        { email, password }
      );
      
      // Update token if login successful
      if (response.token) {
        this.config.token = response.token;
      }
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Login failed'
      };
    }
  }

  // Register
  async register(email: string, password: string, name: string): Promise<AuthResponse> {
    try {
      const response = await this.makeRequest<AuthResponse>(
        'POST',
        '/auth/register',
        { email, password, name }
      );
      
      // Update token if registration successful
      if (response.token) {
        this.config.token = response.token;
      }
      
      return response;
    } catch (error) {
      return {
        error: error.message || 'Registration failed'
      };
    }
  }

  // Get current user
  async getCurrentUser(): Promise<{ user?: UserInfo; error?: string }> {
    try {
      const response = await this.makeRequest<{ user: UserInfo }>(
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
  async logout(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.makeRequest(
        'POST',
        '/auth/logout'
      );
      
      this.config.token = '';
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Logout failed'
      };
    }
  }

  // Set authentication token
  setToken(token: string): void {
    this.config.token = token;
  }

  // Set API key
  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
  }

  // Get last request ID (useful for debugging)
  getLastRequestId(): string {
    return this.requestId;
  }

  // Generate idempotency key
  generateIdempotencyKey(): string {
    return `idem_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  }
}

// Export default client instance factory
export function createLocalizationClient(config: LocalizationClientConfig): LocalizationClient {
  return new LocalizationClient(config);
}


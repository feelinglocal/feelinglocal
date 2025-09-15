# Localization App

A Node.js/Express application for translating and localizing text and document files with multiple AI-powered styles and custom brand voice injection.

## Features

- 🌍 Multi-language translation with cultural adaptation
- 📄 Support for various file formats (TXT, DOCX, PDF, SRT)
- 🎨 Multiple translation styles (formal, casual, creative, technical, marketing)
- 🏷️ Custom brand voice and glossary injection
- 📚 Personal phrasebook management
- 🎬 Subtitle (SRT) file processing with timing preservation

## Setup

### Prerequisites

- Node.js >= 18.0.0
- npm >= 8.0.0
- OpenAI API key

### Installation

1. **Clone and install dependencies:**
   ```bash
   git clone <your-repo>
   cd localization-app
   npm install
   ```

2. **Environment configuration:**
   ```bash
   # Copy the example environment file
   cp .env.example .env
   
   # Edit .env and add your API keys and routing settings:
   OPENAI_API_KEY=sk-your-openai-api-key-here
   GEMINI_API_KEY=your-gemini-api-key
   
   # --- Routing & models ---
   ROUTER_DEFAULT=auto                   # auto | gpt-4o | gemini-2p | gemini-fl
   ROUTER_QE_ENABLED=true
   ROUTER_QE_THRESHOLD=0.72              # 0–1
   ROUTER_COMMITTEE_ENABLED=true
   ROUTER_COMMITTEE_MODE=first_pass_review     # first_pass_review | committee2 | off
   
   # Model ids (override if vendor updates names)
   GEMINI_2P_MODEL=gemini-2.5-pro
   GEMINI_FLASH_LITE_MODEL=gemini-2.5-flash-lite
   OPENAI_MODEL_GPT4O=gpt-4o
   ```

3. **Environment variables:**
   
   Required:
   - `OPENAI_API_KEY` - Your OpenAI API key

Optional:
- `NODE_ENV` - Environment mode (default: development)
- `PORT` - Server port (default: 3000)

### Optional: Redis LangCache (semantic caching)

This app can use Redis LangCache for semantic caching of translations (in addition to the existing exact-key Redis/memory cache). To enable it:

1) Create a LangCache Service in Redis Cloud (or Redis Enterprise) and note:
   - Service base URL ("server URL" in SDK examples)
   - Cache ID
   - API key for the service

2) Install the SDK and set env vars:
   ```bash
   npm install @redis-ai/langcache
   ```
   Add to `.env`:
   ```bash
   LANGCACHE_ENABLED=true
   LANGCACHE_SERVER_URL=https://<your-langcache-endpoint>
   LANGCACHE_CACHE_ID=<your-cache-id>
   LANGCACHE_API_KEY=<your-langcache-api-key>
   # Optional per-request threshold override (0 uses service default)
   # LANGCACHE_THRESHOLD=0.9
   ```

When enabled, the translate API will first check LangCache (semantic search) and return a cached response if a match is found. On cache misses, responses are written to LangCache with attributes: `mode`, `targetLanguage`, `subStyle`, and `engine`.
   - `MAX_UPLOAD_MB` - File upload limit in MB (default: 25)
   - `JWT_SECRET` - Secret for JWT tokens (change in production)
   - `SESSION_SECRET` - Secret for sessions (change in production)
   - `GOOGLE_CLIENT_ID` - Google OAuth client ID
   - `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
   - `SENTRY_DSN` - Sentry error tracking DSN (optional)
   - `LOG_LEVEL` - Logging level (debug, info, warn, error) default: info
   - `S3_BUCKET` - S3 bucket name for file storage (optional)
   - `AWS_ACCESS_KEY_ID` - AWS access key for S3 (optional)
   - `AWS_SECRET_ACCESS_KEY` - AWS secret key for S3 (optional)
   - `S3_REGION` - S3 region (default: us-east-1)
   - `S3_ENDPOINT` - S3 endpoint for compatible services like MinIO (optional)
   - `DEFAULT_FILE_TTL_HOURS` - Default file retention time in hours (default: 24)
   - `BACKUP_RETENTION_DAYS` - Database backup retention in days (default: 30)
   - `STRICT_LANGUAGE_LOCK` - Enforce target-language lock and rephrase language preservation (default: true)
   - `INJECTION_CAP` - Maximum characters for brand/glossary/phrasebook injections (default: 12000)

### Running the Application

```bash
# Development
npm run dev

# Production
npm start
```

The server will start at `http://localhost:3000`

## API Endpoints

### Health Check
```bash
GET /api/health
# Returns: {"ok": true, "uptime": 123.45, "model": "gpt-4o"}
```

### Translation
```bash
POST /api/translate
Content-Type: application/json

{
  "text": "Hello world",
  "mode": "formal",
  "targetLanguage": "French"
}
```

### Batch Translation
```bash
POST /api/translate-batch
Content-Type: application/json

{
  "items": ["Hello", "World"],
  "mode": "formal", 
  "targetLanguage": "French"
}
```

## Smoke Tests

Run these commands to verify the application is working:

```bash
# 1. Health check
curl http://localhost:3000/api/health

# 2. Simple translation test
curl -X POST http://localhost:3000/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","mode":"formal","targetLanguage":"French"}'

# 3. Upload test (replace with actual file)
curl -X POST http://localhost:3000/api/upload \
  -F "file=@test.txt"
```

## Development

### File Structure
```
├── server.js          # Main Express server
├── public/
│   └── index.html     # Frontend application
├── uploads/           # Uploaded files storage
├── userdb/            # User phrasebooks
└── backup/            # Application backups
```

### Key Dependencies
- `express` - Web framework
- `openai` - OpenAI API client
- `multer` - File upload handling
- `mammoth` - DOCX processing
- `pdf-parse` - PDF text extraction
- `srt-parser-2` - Subtitle file parsing

## Production Deployment

For production deployment, ensure:
1. Set `NODE_ENV=production`
2. Use a proper OpenAI API key
3. Configure appropriate upload limits
4. Set up reverse proxy (nginx/Apache)
5. Use process manager (PM2/systemd)

## Troubleshooting

**Server won't start:**
- Check if `OPENAI_API_KEY` is set in `.env`
- Verify Node.js version >= 18.0.0
- Check if port 3000 is available

**Translation errors:**
- Verify OpenAI API key is valid and has credits
- Check network connectivity
- Review server logs for detailed error messages

**File upload issues:**
- Check file size is under the limit (default 25MB)
- Verify file format is supported (TXT, DOCX, PDF, SRT)
- Ensure uploads directory has write permissions

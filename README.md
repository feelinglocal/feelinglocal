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
   
   # Edit .env and add your OpenAI API key:
   OPENAI_API_KEY=sk-your-openai-api-key-here
   ```

3. **Environment variables:**
   
   Required:
   - `OPENAI_API_KEY` - Your OpenAI API key

   Optional:
   - `NODE_ENV` - Environment mode (default: development)
   - `PORT` - Server port (default: 3000)
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

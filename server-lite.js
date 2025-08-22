// server-lite.js - Lightweight server without advanced features for testing
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { OpenAI } = require('openai');
require('dotenv').config();

// Basic configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-key';

const app = express();

// Basic middleware
app.use(cors());
app.use(express.json({ limit: `${MAX_UPLOAD_MB}MB` }));
app.use(express.urlencoded({ extended: true, limit: `${MAX_UPLOAD_MB}MB` }));
app.use(express.static('public'));

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    uptime: process.uptime(),
    version: '1.0.0-lite',
    mode: 'lite'
  });
});

// Basic file upload (no authentication for testing)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/[^\w.-]+/g, '_');
    cb(null, `${Date.now()}_${name}${ext}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    
    let text = '';
    
    // Simple text extraction
    if (ext === '.txt') {
      text = fs.readFileSync(filePath, 'utf8');
    } else {
      text = `File uploaded: ${req.file.originalname} (${ext})`;
    }

    res.json({
      ok: true,
      file: {
        originalName: req.file.originalname,
        size: req.file.size,
        ext: ext.replace('.', ''),
        mime: req.file.mimetype
      },
      text: text
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Basic translation endpoint (for testing)
app.post('/api/translate', async (req, res) => {
  try {
    const { text, mode, targetLanguage } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Simple mock translation for testing
    const result = `[${mode}] Translation to ${targetLanguage}: ${text}`;
    
    res.json({ result });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ error: 'Translation failed' });
  }
});

app.listen(PORT, () => {
  console.log('🚀 Lite server running on http://localhost:' + PORT);
  console.log('📁 Environment:', NODE_ENV);
  console.log('⚡ Mode: Lite (advanced features disabled)');
  console.log('📂 Upload endpoint: http://localhost:' + PORT + '/api/upload');
  console.log('🔍 Health check: http://localhost:' + PORT + '/api/health');
  console.log('');
  console.log('💡 This is a simplified server for testing drag-and-drop functionality');
  console.log('💡 To enable all features, install missing dependencies and use "node server.js"');
});

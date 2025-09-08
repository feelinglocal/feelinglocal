// create-env.js - Create .env file with proper API key
const fs = require('fs');

const envContent = `OPENAI_API_KEY=sk-test-key-for-development
GEMINI_API_KEY=your-gemini-api-key
DEV_AUTH_BYPASS=true
NODE_ENV=development
PORT=3000`;

try {
  fs.writeFileSync('.env', envContent);
  console.log('✅ .env file created with placeholders');
} catch (error) {
  console.error('❌ Failed to create .env file:', error.message);
}



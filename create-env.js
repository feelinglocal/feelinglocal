// create-env.js - Create .env file with proper API key
const fs = require('fs');

const envContent = `OPENAI_API_KEY=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
DEV_AUTH_BYPASS=true
NODE_ENV=development
PORT=3000`;

try {
  fs.writeFileSync('.env', envContent);
  console.log('✅ .env file created with real OpenAI API key');
  console.log('🔑 API key length:', envContent.split('\n')[0].split('=')[1].length, 'characters');
} catch (error) {
  console.error('❌ Failed to create .env file:', error.message);
}

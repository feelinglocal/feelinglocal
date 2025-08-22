// install-deps.js - Install dependencies one by one to avoid conflicts
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const requiredDependencies = [
  'socket.io@^4.8.1',
  '@node-saml/passport-saml@^4.0.7', 
  'node-cache@^5.1.2',
  'jose@^5.9.6',
  'crypto-js@^4.2.0'
];

async function installDependencies() {
  console.log('📦 Installing missing dependencies...');
  
  for (const dep of requiredDependencies) {
    try {
      console.log(`Installing ${dep}...`);
      await execAsync(`npm install ${dep}`, { timeout: 60000 });
      console.log(`✅ ${dep} installed successfully`);
    } catch (error) {
      console.log(`⚠️ Failed to install ${dep}:`, error.message);
      console.log(`Trying with --force flag...`);
      try {
        await execAsync(`npm install ${dep} --force`, { timeout: 60000 });
        console.log(`✅ ${dep} installed with --force`);
      } catch (forceError) {
        console.log(`❌ ${dep} failed even with --force:`, forceError.message);
      }
    }
  }
  
  console.log('📦 Dependency installation completed');
}

if (require.main === module) {
  installDependencies().catch(console.error);
}

module.exports = { installDependencies };

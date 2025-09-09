// setup-admin.js - Quick admin user setup script
const bcrypt = require('bcryptjs');
const db = require('./database');

async function setupAdmin() {
  try {
    console.log('🔧 Setting up admin user...');
    
    // Initialize database first
    await db.init();
    
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@localhost';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminName = process.env.ADMIN_NAME || 'Administrator';
    
    // Check if admin already exists
    const existingAdmin = await db.get('SELECT id FROM users WHERE email = ?', [adminEmail]);
    
    if (existingAdmin) {
      console.log('✅ Admin user already exists:', adminEmail);
      console.log('🔑 Use these credentials to log in:');
      console.log('   Email:', adminEmail);
      console.log('   Password:', adminPassword);
      return;
    }
    
    // Create admin user
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const result = await db.run(`
      INSERT INTO users (email, password_hash, name, tier, is_active, created_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `, [adminEmail, passwordHash, adminName, 'business']);
    
    console.log('🎉 Admin user created successfully!');
    console.log('');
    console.log('📧 Email:', adminEmail);
    console.log('🔑 Password:', adminPassword);
    console.log('👑 Tier: business (highest tier)');
    console.log('');
    console.log('🚀 You can now log in at: http://localhost:3000');
    console.log('');
    console.log('📝 To use the API, you can:');
    console.log('1. Register/Login via the web interface');
    console.log('2. Use the JWT token in Authorization header');
    console.log('3. Create an API key from the user dashboard');
    console.log('');
    console.log('🔐 For immediate access, you can also use:');
    console.log('curl -X POST http://localhost:3000/auth/login \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log(`  -d '{"email":"${adminEmail}","password":"${adminPassword}"}'`);
    
  } catch (error) {
    console.error('❌ Failed to setup admin user:', error.message);
    process.exit(1);
  }
}

// Run setup if called directly
if (require.main === module) {
  setupAdmin().then(() => {
    process.exit(0);
  });
}

module.exports = { setupAdmin };



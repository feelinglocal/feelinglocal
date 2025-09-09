// auth.js - Authentication middleware and utilities
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./database');

// JWT secret - should be in environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Supabase configuration (browser uses ANON KEY; server uses URL + ANON to introspect tokens)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '5000', 10);

// Small helper to add timeouts to fetch
async function fetchWithTimeout(resource, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Tier configurations
const TIERS = {
  free: {
    name: 'Free',
    maxRequestsPerDay: 50,
    maxInputSize: 1000, // characters per request
    maxMonthlyChars: 3500, // characters per month
    batchAllowed: false,
    zipDownloadAllowed: false,
    phrasebookAllowed: true
  },
  pro: {
    name: 'Pro',
    maxRequestsPerDay: 500,
    maxInputSize: 10000,
    maxMonthlyChars: 100000,
    batchAllowed: true,
    zipDownloadAllowed: true,
    phrasebookAllowed: true
  },
  business: {
    name: 'Business',
    maxRequestsPerDay: 5000,
    maxInputSize: 50000,
    maxMonthlyChars: 500000,
    batchAllowed: true,
    zipDownloadAllowed: true,
    phrasebookAllowed: true,
    orgSeats: 10,
    ssoAllowed: true,
    priorityQueue: true
  }
};

// Hash password
async function hashPassword(password) {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

// Verify password
async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// Generate JWT token
function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    tier: user.tier,
    iat: Math.floor(Date.now() / 1000)
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Verify a Supabase JWT using the project's JWKS (robust for production)
async function verifySupabaseJWT(accessToken) {
  if (!SUPABASE_URL) return null;
  // 1) Try RS256 (JWKS) verification first
  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/keys`));
    const { payload } = await jwtVerify(accessToken, jwks, { algorithms: ['RS256'] });
    return { id: payload.sub, email: payload.email || payload.user_email || null, user_metadata: payload.user_metadata || {} };
  } catch (e) {
    // Fall through to HTTP introspection
  }

  // 2) Fallback: call Supabase Auth user endpoint with SRK/ANON apikey
  try {
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': apiKey }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.id ? data : null;
  } catch (e2) {
    return null;
  }
}

// Fetch full Supabase user to check confirmation status (used if JWKS payload lacks fields)
async function fetchSupabaseUser(accessToken) {
  if (!SUPABASE_URL) return null;
  try {
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': apiKey }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

// Fetch tier from Supabase public.profiles using Service Role (preferred) or ANON (read-only)
async function fetchProfileTier(userId) {
  if (!SUPABASE_URL) return null;
  try {
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    if (!apiKey) return null;
    const url = new URL(`${SUPABASE_URL}/rest/v1/profiles`);
    url.searchParams.set('id', `eq.${userId}`);
    url.searchParams.set('select', 'tier');
    url.searchParams.set('limit', '1');
    const res = await fetchWithTimeout(url.toString(), {
      headers: {
        'apikey': apiKey,
        'Authorization': `Bearer ${apiKey}`
      }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row && typeof row.tier === 'string' ? String(row.tier) : null;
  } catch (_) {
    return null;
  }
}

// Passport Local Strategy
passport.use(new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
    
    if (!user) {
      return done(null, false, { message: 'Invalid email or password' });
    }

    const isValidPassword = await verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      return done(null, false, { message: 'Invalid email or password' });
    }

    return done(null, user);
  } catch (error) {
    return done(error);
  }
}));

// Passport Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      // Check if user exists
      let user = await db.get('SELECT * FROM users WHERE provider_id = ? AND provider = ?', 
        [profile.id, 'google']);

      if (!user) {
        // Create new user
        const result = await db.run(`
          INSERT INTO users (email, name, provider, provider_id, tier)
          VALUES (?, ?, ?, ?, ?)
        `, [
          profile.emails[0].value,
          profile.displayName,
          'google',
          profile.id,
          'free'
        ]);

        user = await db.get('SELECT * FROM users WHERE id = ?', [result.id]);
      }

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }));
}

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ? AND is_active = 1', [id]);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

// Authentication middleware
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.session?.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // 1) Try local JWT (legacy)
  const decoded = verifyToken(token);
  if (decoded) {
    req.user = decoded;
    return next();
  }

  // 2) Try Supabase JWT introspection
  const supaUser = await verifySupabaseJWT(token);
  if (supaUser && supaUser.id) {
    let emailConfirmed = !!(supaUser.email_confirmed_at || supaUser.confirmed_at);
    if (!emailConfirmed) {
      const full = await fetchSupabaseUser(token);
      emailConfirmed = !!(full?.email_confirmed_at || full?.confirmed_at);
    }
    if (!emailConfirmed) {
      return res.status(403).json({ error: 'Email not confirmed' });
    }

    // Always derive tier from profiles table (source of truth)
    const dbTier = await fetchProfileTier(supaUser.id);
    const effectiveTier = dbTier && ['free','pro','business'].includes(dbTier.toLowerCase()) ? dbTier.toLowerCase() : 'free';

    // Expose MFA signals
    const aal = supaUser?.aal || (supaUser?.amr?.includes('mfa') ? 'aal2' : (supaUser?.amr?.includes('pwd') ? 'aal1' : undefined));
    const mfaEnabled = !!(supaUser?.user_metadata?.two_factor_enabled);
    req.user = {
      id: supaUser.id,
      email: supaUser.email,
      tier: effectiveTier,
      aal,
      mfaEnabled
    };
    return next();
  }

  return res.status(401).json({ error: 'Invalid or expired token' });
};

// API Key authentication middleware
const requireApiKey = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    // Hash the provided API key to compare with stored hash
    const apiKeyRecord = await db.get(`
      SELECT ak.*, u.tier, u.email, u.id as user_id
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.key_hash = ? AND ak.is_active = 1 AND u.is_active = 1
    `, [await hashPassword(apiKey)]);

    if (!apiKeyRecord) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Update last used timestamp
    await db.run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', 
      [apiKeyRecord.id]);

    req.user = {
      id: apiKeyRecord.user_id,
      email: apiKeyRecord.email,
      tier: apiKeyRecord.tier,
      apiKeyId: apiKeyRecord.id,
      orgId: apiKeyRecord.org_id
    };

    next();
  } catch (error) {
    console.error('API key verification error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Check user tier permissions
const checkTierPermission = (feature) => {
  return (req, res, next) => {
    const userTier = req.user?.tier || 'free';
    const tierConfig = TIERS[userTier];

    if (!tierConfig) {
      return res.status(403).json({ error: 'Invalid user tier' });
    }

    // Check specific feature permissions
    switch (feature) {
      case 'batch':
        if (!tierConfig.batchAllowed) {
          return res.status(403).json({ 
            error: 'Batch processing requires Pro or Business tier',
            currentTier: userTier,
            requiredTier: 'pro'
          });
        }
        break;
      case 'zip':
        if (!tierConfig.zipDownloadAllowed) {
          return res.status(403).json({ 
            error: 'ZIP download requires Pro or Business tier',
            currentTier: userTier,
            requiredTier: 'pro'
          });
        }
        break;
      default:
        break;
    }

    req.tierConfig = tierConfig;
    next();
  };
};

module.exports = {
  TIERS,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAuth,
  requireApiKey,
  checkTierPermission,
  passport
};

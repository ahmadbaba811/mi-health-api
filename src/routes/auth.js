const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../db');
const { findOrCreateOAuthUser, isEmailRegistered, completeOAuthSignIn, verifyGoogleIdToken, logSuccessfulLogin, signAppToken, verifyMicrosoftIdToken } = require('../utils/oAuth');


// Rate limiting: 5 failed login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: 'Too many login attempts',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  skipSuccessfulRequests: true,
  skip: (req) => {
    // Skip rate limiting for non-login endpoints
    return req.path !== '/login' && req.path !== '/google';
  }
});

const passwordOpsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many password reset requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Input validation helper
function validateLoginInput(email, password) {
  const errors = [];

  if (!email || typeof email !== 'string') {
    errors.push('Email is required');
  } else if (!isValidEmail(email)) {
    errors.push('Invalid email format');
  } else if (email.length > 255) {
    errors.push('Email is too long');
  }

  if (!password || typeof password !== 'string') {
    errors.push('Password is required');
  } else if (password.length < 1) {
    errors.push('Invalid password');
  } else if (password.length > 512) {
    errors.push('Password is too long');
  }

  return errors;
}

// Email validation helper
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Phone validation helper: allows optional leading +, 7-15 digits total
function isValidPhone(phone) {
  const phoneRegex = /^\+?[0-9]{7,15}$/;
  return phoneRegex.test(phone);
}

// Password strength checker: min 8 chars, upper/lowercase, number, special char
function checkPasswordStrength(password) {
  const errors = [];

  if (!password || typeof password !== 'string') {
    return ['Password is required'];
  }

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return errors;
}

// Log failed login attempts
async function logFailedLogin(email, reason) {
  try {
    const request = pool.request();
    request.input('email', sql.VarChar(255), email);
    request.input('reason', sql.VarChar(255), reason);
    request.input('timestamp', sql.DateTime, new Date());

    await request.query(`
      INSERT INTO login_attempts (email, success, reason, timestamp)
      VALUES (@email, 0, @reason, @timestamp)
    `);
  } catch (err) {
    console.error('Error logging failed login:', err);
  }
}


// Check account lockout (failed attempts)
async function isAccountLocked(email) {
  try {
    const request = pool.request();
    request.input('email', sql.VarChar(255), email);
    request.input('threshold', sql.Int, 5);
    request.input('timeWindow', sql.Int, 15); // 15 minutes

    const result = await request.query(`
      SELECT COUNT(*) as failedAttempts 
      FROM login_attempts 
      WHERE email = @email 
        AND success = 0 
        AND timestamp > DATEADD(MINUTE, -@timeWindow, GETUTCDATE())
    `);

    return result.recordset[0].failedAttempts >= 5;
  } catch (err) {
    console.error('Error checking account lockout:', err);
    return false;
  }
}

// POST /login - Secure login endpoint
//router.post('/login', loginLimiter,
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  // Input validation
  const validationErrors = validateLoginInput(email, password);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Invalid input',
      details: validationErrors
    });
  }

  // Sanitize email
  const sanitizedEmail = email.trim().toLowerCase();

  try {
    // Check if account is locked
    if (await isAccountLocked(sanitizedEmail)) {
      await logFailedLogin(sanitizedEmail, 'Account locked due to too many failed attempts');
      return res.status(429).json({
        error: 'temporarily locked',
        message: 'Account temporarily locked. Please try again in 15 minutes.'
      });
    }

    // Fetch user from database
    const request = pool.request();
    request.input('email', sql.VarChar(255), sanitizedEmail);

    const result = await request.query(`
      SELECT id, email, phone, passwordHash, isActive, firstName, lastName, emailVerified, birthYear, photoUrl FROM Users 
      WHERE email = @email
    `);

    // User not found
    if (result.recordset.length === 0) {
      await logFailedLogin(sanitizedEmail, 'User not found');
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    const user = result.recordset[0];

    // Check if account is active
    if (!user.isActive) {
      await logFailedLogin(sanitizedEmail, 'Inactive account');
      return res.status(403).json({
        error: 'inactive',
        message: 'Account is inactive. Please contact support.'
      });
    }

    // Check if email is verified
    if (user.emailVerified === null) {
      await logFailedLogin(sanitizedEmail, 'Email not verified');
      return res.status(403).json({
        error: 'inactive',
        message: 'Account not verified. Please contact support.'
      });
    }

    // Compare password with hash
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatch) {
      await logFailedLogin(sanitizedEmail, 'Invalid password');
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    // Generate JWT token
    const token = await signAppToken(user);

    // Log successful login
    await logSuccessfulLogin(user.id, email);

    // Return success with token
    res.status(200).json({
      success: true,
      message: 'Login successful',
      token: token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        birthYear: user.birthYear,
        photoUrl: user.photoUrl,
        phone: user.phone
      }
    });

  } catch (err) {
    console.error('Error during login:', err);
    // Never expose internal errors to client
    res.status(500).json({
      error: "error occured",
      message: 'An error occurred during login. Please try again later.'
    });
  }
});


// oAuth Login with google
router.post("/google", loginLimiter, async (req, res) => {
  const { token } = req.body || {}
  if (!token) {
    return res.status(400).json({ error: 'Invalid input', details: ['Missing Google token'] })
  }

  try {
    const profile = await verifyGoogleIdToken(token)
    await completeOAuthSignIn(res, profile)
  } catch (error) {
    // console.log(error)
    console.error("Google sign-in failed:", error.message)
    res.status(401).json({ error: 'Google sign in failed' })
  }
})


// oAuth Login with microsoft
router.post("/microsoft", async (req, res) => {
  const { token } = req.body || {}
  if (!token) {
    return res.status(400).json({ error: 'Invalid input', details: ['Missing Microsoft token'] })
  }

  try {
    const profile = await verifyMicrosoftIdToken(token)
    console.log(profile)
    await completeOAuthSignIn(res, profile)
  } catch (error) {
    console.error("Microsoft sign-in failed:", error.message)
    res.status(401).json({ error: 'Microsoft sign in failed' })
  }
})

























function validateRegisterInput(email, password, confirmPassword, phone) {
  const errors = validateLoginInput(email, password);

  if (!confirmPassword || typeof confirmPassword !== 'string') {
    errors.push('Password confirmation is required');
  } else if (password !== confirmPassword) {
    errors.push('Passwords do not match');
  }

  if (password && password.length > 0) {
    errors.push(...checkPasswordStrength(password));
  }

  if (!isValidPhone(phone.trim())) {
    errors.push('Invalid phone number format');
  }

  return errors;
}



// POST /register - Account creation endpoint
router.post('/register', async (req, res) => {
  const { email, password, confirmPassword, firstName, lastName, phone, address, orgName, accountType, birthYear } = req.body;

  const validationErrors = validateRegisterInput(email, password, confirmPassword, phone);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Invalid registration data',
      details: validationErrors
    });
  }

  const sanitizedEmail = email.trim().toLowerCase();

  try {
    if (await isEmailRegistered(sanitizedEmail)) {
      return res.status(409).json({
        error: 'Email is already registered'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const request = pool.request();
    request.input('email', sql.VarChar(255), sanitizedEmail);
    request.input('passwordHash', sql.VarChar(512), passwordHash);
    request.input('birthYear', sql.Numeric(), birthYear);
    request.input('isActive', sql.Bit, 1);
    request.input('firstName', sql.VarChar(255), firstName);
    request.input('lastName', sql.VarChar(255), lastName);
    request.input('phone', sql.VarChar(255), phone);
    request.input('address', sql.VarChar(255), address);
    request.input('orgName', sql.VarChar(255), orgName);
    request.input('accountType', sql.VarChar(255), accountType);

    await request.query(`
      INSERT INTO Users(email, firstName, lastName, birthYear, phone, passwordHash, isActive, createdAt, accountType ${accountType === "organisation" ? `, address, orgName` : ''})
      VALUES
      (@email, @firstName, @lastName, @birthYear, @phone, @passwordHash, @isActive, SYSUTCDATETIME(), @accountType ${accountType === "organisation" ? `, @address, @orgName, ` : ''})
  `);

    const fetchRequest = pool.request();
    fetchRequest.input('email', sql.VarChar(255), sanitizedEmail);
    const fetchResult = await fetchRequest.query(`
      SELECT id, email
      FROM Users
      WHERE email = @email
  `);

    const newUser = fetchResult.recordset[0];

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: {
        id: newUser.id,
        email: newUser.email
      }
    });
  } catch (err) {
    console.error('Error during registration:', err);
    res.status(500).json({
      error: 'Registration failed. Please try again later.'
    });
  }
});



// GET page data counts
router.get('/page-data', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`SELECT DISTINCT Count(id) as labsCount FROM labs`);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});


// GET registered email
router.get('/check-email/:email', async (req, res) => {
  try {
    if (!req.params.email || !isValidEmail(req.params.email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const request = pool.request();
    request.input('email', sql.VarChar(50), req.params.email);

    const result = await request.query(`SELECT email, firstName from users WHERE email = @email`);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

router.post('/request-password-reset', passwordResetRequestLimiter, async (req, res) => {
  try {
    const email = req.body?.email;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'A valid email is required.'
      });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    const request = pool.request();
    request.input('email', sql.VarChar(255), sanitizedEmail);

    const result = await request.query(`
      SELECT id, email, firstName, lastName, passwordHash
      FROM users
      WHERE email = @email
    `);

    // Do not disclose account existence.
    if (result.recordset.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'If the account exists, a password reset link has been sent.'
      });
    }

    const user = result.recordset[0];
    const resetToken = jwt.sign(
      {
        purpose: 'password_reset',
        userId: user.id,
        email: user.email,
        pwdv: user.passwordHash,
        jti: crypto.randomUUID()
      },
      process.env.JWT_SECRET || 'your-secret-key',
      {
        expiresIn: '15m',
        issuer: 'mi-health-api',
        audience: 'mi-health-client'
      }
    );

    const frontendBaseUrl = process.env.NODE_ENV === "dev" ?
      process.env.CLIENT_APP_URL_DEV : process.env.CLIENT_APP_URL_LIVE || '';
    const resetUrl = frontendBaseUrl
      ? `${frontendBaseUrl.replace(/\/$/, '')}/reset-password/${encodeURIComponent(resetToken)}`
      : null;

    return res.status(200).json({
      success: true,
      user: user,
      resetUrl: resetUrl,
      message: 'If the account exists, a password reset link has been sent.'
    });
  } catch (err) {
    console.error('Error requesting password reset:', err);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// POST change password
router.post('/reset-password', passwordOpsLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || typeof token !== 'string' || !newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'A valid reset token and a password with at least 8 characters are required.'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', {
        issuer: 'mi-health-api',
        audience: 'mi-health-client'
      });
    } catch (_verifyErr) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    if (decoded?.purpose !== 'password_reset' || !decoded?.email || !decoded?.userId || !decoded?.pwdv) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const request = pool.request();
    request.input('email', sql.VarChar(255), String(decoded.email).trim().toLowerCase());
    const userResult = await request.query(`SELECT id, firstName, lastName, passwordHash FROM users WHERE email = @email`);

    const user = userResult.recordset[0];
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    if (Number(user.id) !== Number(decoded.userId) || user.passwordHash !== decoded.pwdv) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const samePassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (samePassword) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'New password must be different from your current password.'
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    request.input('id', sql.Int, user.id);
    request.input('passwordHash', sql.NVarChar(500), passwordHash)

    await request.query(`UPDATE users SET passwordHash = @passwordHash WHERE id = @id`);

    const result = await request.query(`SELECT email, firstName, lastName FROM users WHERE id = @id`);

    res.status(200).json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

module.exports = router;

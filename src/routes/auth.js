const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../db');
const { verifyToken } = require('../middleware/auth');


// Rate limiting: 5 failed login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: 'Too many login attempts',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  skip: (req) => {
    // Skip rate limiting for health checks or non-login endpoints
    return req.path !== '/login';
  }
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

// Log successful login
async function logSuccessfulLogin(userId, email) {
  try {
    const request = pool.request();
    request.input('userId', sql.Int, userId);
    request.input('email', sql.VarChar(255), email);
    request.input('timestamp', sql.DateTime, new Date());

    await request.query(`
      INSERT INTO login_attempts (userId, success, timestamp, email)
      VALUES (@userId, 1, @timestamp, @email)
    `);
  } catch (err) {
    console.error('Error logging successful login:', err);
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
router.post('/login',  async (req, res) => {
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
      SELECT id, email, passwordHash, isActive, firstName, lastName FROM Users 
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

    // Compare password with hash
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatch) {
      await logFailedLogin(sanitizedEmail, 'Invalid password');
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email
      },
      process.env.JWT_SECRET || 'your-secret-key',
      {
        expiresIn: '24h',
        issuer: 'mi-health-api',
        audience: 'mi-health-client'
      }
    );

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
        lastName: user.lastName
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

function validateRegisterInput(email, password, confirmPassword) {
  const errors = validateLoginInput(email, password);

  if (!confirmPassword || typeof confirmPassword !== 'string') {
    errors.push('Password confirmation is required');
  } else if (password !== confirmPassword) {
    errors.push('Passwords do not match');
  }

  if (password && password.length > 0 && password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  return errors;
}

async function isEmailRegistered(email) {
  try {
    const request = pool.request();
    request.input('email', sql.VarChar(255), email);

    const result = await request.query(`
      SELECT COUNT(1) AS existingCount
      FROM Users
      WHERE email = @email
    `);

    return result.recordset[0].existingCount > 0;
  } catch (err) {
    console.error('Error checking email existence:', err);
    return false;
  }
}

// POST /register - Account creation endpoint
router.post('/register', async (req, res) => {

  const { email, password, confirmPassword, firstName, lastName, phone, address } = req.body;

  const validationErrors = validateRegisterInput(email, password, confirmPassword);
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
    request.input('isActive', sql.Bit, 1);
    request.input('firstName', sql.VarChar(255), firstName);
    request.input('lastName', sql.VarChar(255), lastName);
    request.input('phone', sql.VarChar(255), phone);
    request.input('address', sql.VarChar(255), address);

    await request.query(`
      INSERT INTO Users (email, firstName, lastName, phone, address, passwordHash, isActive, createdAt)
      VALUES (@email, @firstName, @lastName, @phone, @address, @passwordHash, @isActive, SYSUTCDATETIME())
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

// POST /logout - Optional logout endpoint (invalidate token on client side)
router.post('/logout', (req, res) => {
  // JWT tokens are stateless, so logout is handled on client by removing token
  // Optionally maintain a token blacklist in database

  res.status(200).json({
    message: 'Logout successful. Please remove your token.'
  });
});

module.exports = router;

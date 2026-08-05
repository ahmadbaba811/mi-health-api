const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { verifyToken } = require('../../middleware/auth');



function validateRegisterInput(email, password, confirmPassword) {
  const errors = [];

  if (!email?.trim()) errors.push("Email is required");

  if (!password) errors.push("Password is required");

  if (password !== confirmPassword)
    errors.push("Passwords do not match");

  if (password && password.length < 6)
    errors.push("Password must be at least 6 characters");

  return errors;
}


async function isEmailRegistered(email) {
  const request = pool.request();

  request.input("email", sql.VarChar(255), email);

  const result = await request.query(`
    SELECT id FROM lab_admins WHERE email = @email
  `);

  return result.recordset.length > 0;
}

// POST /register  Account creation endpoint for Lab Admins
router.post('/register', async (req, res) => {

  const { labId, email, password, confirmPassword, firstName, lastName, phone } = req.body;

  const validationErrors = validateRegisterInput(email, password, confirmPassword);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Invalid registration data',
      details: validationErrors
    });
  }

  // check Lab-id to ensure its not empty
  if (!labId) {
    return res.status(400).json({ error: 'labId is required' });
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
    request.input('labId', sql.Int, labId);
    request.input('email', sql.VarChar(255), sanitizedEmail);
    request.input('passwordHash', sql.VarChar(512), passwordHash);
    request.input('firstName', sql.VarChar(255), firstName);
    request.input('lastName', sql.VarChar(255), lastName);
    request.input('phone', sql.VarChar(255), phone);
    request.input('isActive', sql.Bit, 1);
    request.input('failedLoginCount', sql.Int, 0);
    request.input('createdBy', sql.VarChar(255), 'System');


    await request.query(`
      INSERT INTO lab_admins (
        labId, firstName, lastName, email, phone, passwordHash, 
        failedLoginCount, isActive, createdAt, createdBy
      )
      VALUES (
        @labId, @firstName, @lastName, @email, @phone, @passwordHash, 
        @failedLoginCount, @isActive, SYSUTCDATETIME(), @createdBy
      )
    `);


    const fetchRequest = pool.request();
    fetchRequest.input('email', sql.VarChar(255), sanitizedEmail);
    const fetchResult = await fetchRequest.query(`
      SELECT id, labId, email
      FROM lab_admins
      WHERE email = @email
    `);

    const newAdmin = fetchResult.recordset[0];

    res.status(201).json({
      success: true,
      message: 'Lab admin account created successfully',
      user: {
        id: newAdmin.id,
        labId: newAdmin.labId,
        email: newAdmin.email
      }
    });
  } catch (err) {
    console.error('Error during registration:', err);
    res.status(500).json({
      error: 'Registration failed. Please try again later.'
    });
  }
});

router.post('/login', async (req, res) => {
  const { labId, email, password, mode } = req.body;
  const isSuper = req.body.source === "super"

  // Validation
  if (!email || !password) {
    return res.status(400).json({
      error: 'email and password are required'
    });
  }

  const sanitizedEmail = email.trim().toLowerCase();

  try {

    const request = pool.request();

    request.input('email', sql.VarChar(255), sanitizedEmail);
    request.input('labId', sql.Int, labId ?? null);
    let result
    if (isSuper) {
      if (mode === "lab") {
        if (!labId) {
          return res.status(400).json({ error: 'labId is required in lab mode' });
        }
        console.log('check lab', labId)
        let query = `
            SELECT a.id, labId, firstName, lastName, a.email, passwordHash, a.isActive, failedLoginCount, b.name
            FROM lab_admins a INNER JOIN labs b ON a.labId = b.id
            WHERE a.labId = @labId
        `
        result = await request.query(query);
      } else {
        console.log('check super')
        result = await request.query(`
            SELECT a.id, labId, firstName, lastName, a.email, passwordHash, a.isActive, failedLoginCount, b.name
            FROM lab_admins a INNER JOIN labs b ON a.labId = b.id
            WHERE a.email = @email AND isSuper = 1
        `);
      }
    } else {
      result = await request.query(`
            SELECT a.id, labId, firstName, lastName, a.email, passwordHash, a.isActive, failedLoginCount, b.name
            FROM lab_admins a INNER JOIN labs b ON a.labId = b.id
            WHERE a.email = @email
        `);
    }

    // Admin not found
    if (result.recordset.length === 0) {
      
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    const admin = result.recordset[0];
    // Account disabled
    if (!admin.isActive) {
      return res.status(403).json({
        error: 'Account is inactive'
      });
    }

    // Password verification
    if (!isSuper) {
      console.log('check2')
      const passwordMatch = await bcrypt.compare(
        password,
        admin.passwordHash
      );

      if (!passwordMatch) {
        return res.status(401).json({
          error: 'Invalid credentials'
        });
      }
    }


    // Generate JWT
    const token = jwt.sign(
      {
        adminId: admin.id,
        labId: admin.labId,
        email: admin.email,
        role: 'LabAdmin'
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '24h',
        issuer: 'mi-health-api',
        audience: 'mi-health-admin'
      }
    );

    // Update last login timestamp
    await pool.request()
      .input('id', sql.Int, admin.id)
      .query(`
                UPDATE lab_admins
                SET lastLoginAt = SYSUTCDATETIME()
                WHERE id = @id
            `);

    const adminLabServices = await pool.request()
      .input('labId', sql.Int, admin.labId)
      .query(`SELECT s.id, s.name, ls.price, ls.duration, s.category, s.description, ls.preparation
                        FROM lk_Services s
                        INNER JOIN lab_services ls ON s.id = ls.serviceId
                        WHERE ls.labId = @labId
                        ORDER BY s.createdAt DESC`);
    const labServices = adminLabServices.recordset

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: admin.id,
        labId: admin.labId,
        lab: { labId: admin.labId, labName: admin.name, services: labServices },
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: 'LabAdmin'
      }
    });

  } catch (err) {

    console.error('Admin login error:', err);

    return res.status(500).json({
      error: 'An error occurred during login'
    });
  }
});

module.exports = router;
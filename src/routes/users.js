const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { buildEmailHtml } = require('../templates/email-template');

// GET /users - list users (example)
router.get('/', verifyToken, async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query('SELECT TOP (100) * FROM [Users]');
    res.json(result.recordset || []);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /users/:id - get user by id (example)
router.get('/:id', verifyToken, async (req, res) => {
  const id = req.params.id;
  const tokenUserId = req.user?.userId;

  if (!tokenUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (Number(tokenUserId) !== Number(id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const request = pool.request();
    request.input('id', sql.Int, Number(id));
    const result = await request.query('SELECT id, firstName, lastName, orgName, email, phone, altPhone, address, birthYear, photoUrl FROM users WHERE id = @id');
    const user = result.recordset[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT /users/:id - update user
router.put('/:id', verifyToken, async (req, res) => {

  const id = req.params.id;
  const tokenUserId = req.user?.userId;

  if (!tokenUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (Number(tokenUserId) !== Number(id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    accountType,
    firstName,
    lastName,
    orgName,
    phone,
    altPhone,
    address,
    birthYear,
  } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.Int, id);
    request.input('accountType', sql.VarChar(50), accountType);
    request.input('firstName', sql.VarChar(255), firstName);
    request.input('lastName', sql.VarChar(255), lastName);
    request.input('orgName', sql.VarChar(255), orgName);
    request.input('phone', sql.VarChar(50), phone);
    request.input('altPhone', sql.VarChar(50), altPhone);
    request.input('address', sql.VarChar(500), address);
    request.input('birthYear', sql.Int, birthYear);

    const result = await request.query(`
      UPDATE users
      SET
        firstName = @firstName,
        lastName = @lastName,
        orgName = @orgName,
        phone = @phone,
        altPhone = @altPhone,
        address = @address,
        birthYear = @birthYear
      WHERE id = @id;

      SELECT id, accountType, firstName, lastName, orgName, email, phone, altPhone, address, birthYear, photoUrl
      FROM users
      WHERE id = @id;
    `);

    const user = result.recordset[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});


router.post('/verify-email', async (req, res) => {
  const email = req.body.email;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  try {
    const request = pool.request();
    request.input('email', sql.VarChar(255), email);
    const result = await request.query('SELECT id, email, firstName, emailVerified FROM [Users] WHERE email = @email ');
    const user = result.recordset[0]

    if (user && user.emailVerified === null) {
      await request.query(`UPDATE users SET emailVerified = 'verified' WHERE email=@email`)
      return res.status(200).json({ verified: true, email: email, firstName: user.firstName })
    }

    if (user && user.emailVerified === 'verified') {
      return res.status(200).json({ exists: true })
    }

    if (!user) return res.status(404).json({ error: 'User not found' });
  } catch (err) {
    console.log(err)
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.post('/send-email', async (req, res) => {
  try {
    const { to, subject } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Recipient email is required' });
    }

    const now = new Date().getFullYear();
    const html = buildEmailHtml({ html: req.body.html, now: now });
    const bcc = !req.body.bcc ? null : req.body.bcc;
    const attachment = !req.body.attachment ? null : req.body.attachment;
    const info = await sendEmail({
      to: to,
      bcc: bcc,
      subject: subject,
      html: html,
      attachment
    });

    res.status(200).json({
      success: true,
      message: 'Welcome email sent successfully'
    });
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to send email',
    });
  }
});



module.exports = router;

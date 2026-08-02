const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { sendEmail } = require('../utils/email');
const { buildEmailHtml } = require('../templates/email-template');

// GET /users - list users (example)
router.get('/', async (req, res) => {
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
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const request = pool.request();
    request.input('id', sql.Int, id);
    const result = await request.query('SELECT * FROM [Users] WHERE Id = @id');
    const user = result.recordset[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
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
    const info = await sendEmail({
      to: to,
      bcc: bcc,
      subject: subject,
      html: html
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


router.post('/verify-email', async (req, res) => {
  const email = req.body.email;
  try {
    const request = pool.request();
    request.input('email', sql.VarChar(255), email);
    const result = await request.query('SELECT * FROM [Users] WHERE email = @email ');
    const user = result.recordset[0]
    if (user && user.emailVerified === null) {
      await request.query(`UPDATE users SET emailVerified = 'verified' WHERE email=@email`)
      res.status(200).json({ verified: true })
    }

    if (user && user.emailVerified === 'verified') {
      res.status(200).json({ exists: true })
    }

    if (!user) return res.status(404).json({ error: 'User not found' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;

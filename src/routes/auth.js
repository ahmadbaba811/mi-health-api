const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');

router.post('/login', async (req, res) => {
  const { email, pwd } = req.body;

  try {
    const request = pool.request();
    request.input('email', email);
    request.input('pwd', pwd);

    const result = await request.query(`SELECT email, password_hash FROM Users WHERE email = @email AND password_hash = @pwd `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});



module.exports = router;

const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');

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

module.exports = router;

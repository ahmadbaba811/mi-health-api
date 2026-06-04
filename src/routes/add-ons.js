const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');

// GET all premium add-ons
router.get('/', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, name, price, requiresScheduling, description 
      FROM PremiumAddOns 
      ORDER BY price ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching add-ons:', err);
    res.status(500).json({ error: 'Failed to fetch add-ons' });
  }
});

// GET single add-on by ID
router.get('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    const result = await request.query(`
      SELECT id, name, price, requiresScheduling, description 
      FROM PremiumAddOns 
      WHERE id = @id
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Add-on not found' });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error fetching add-on:', err);
    res.status(500).json({ error: 'Failed to fetch add-on' });
  }
});

// POST create new add-on
router.post('/', async (req, res) => {
  const { id, name, price, requiresScheduling, description } = req.body;

  if (!id || !name || price === undefined || requiresScheduling === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), id);
    request.input('name', sql.VarChar(255), name);
    request.input('price', sql.Int, price);
    request.input('requiresScheduling', sql.Bit, requiresScheduling);
    request.input('description', sql.VarChar(sql.MAX), description || '');

    await request.query(`
      INSERT INTO PremiumAddOns (id, name, price, requiresScheduling, description)
      VALUES (@id, @name, @price, @requiresScheduling, @description)
    `);

    res.status(201).json({ id, name, price, requiresScheduling, description });
  } catch (err) {
    console.error('Error creating add-on:', err);
    res.status(500).json({ error: 'Failed to create add-on' });
  }
});

// PUT update add-on
router.put('/:id', async (req, res) => {
  const { name, price, requiresScheduling, description } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);
    request.input('name', sql.VarChar(255), name);
    request.input('price', sql.Int, price);
    request.input('requiresScheduling', sql.Bit, requiresScheduling);
    request.input('description', sql.VarChar(sql.MAX), description || '');

    await request.query(`
      UPDATE PremiumAddOns 
      SET name = @name, price = @price, requiresScheduling = @requiresScheduling, description = @description
      WHERE id = @id
    `);

    res.json({ id: req.params.id, name, price, requiresScheduling, description });
  } catch (err) {
    console.error('Error updating add-on:', err);
    res.status(500).json({ error: 'Failed to update add-on' });
  }
});

// DELETE add-on
router.delete('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    await request.query('DELETE FROM PremiumAddOns WHERE id = @id');

    res.json({ message: 'Add-on deleted successfully' });
  } catch (err) {
    console.error('Error deleting add-on:', err);
    res.status(500).json({ error: 'Failed to delete add-on' });
  }
});

module.exports = router;

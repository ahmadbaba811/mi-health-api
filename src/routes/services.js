const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// GET all services
router.get('/', verifyToken, async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, name, price, duration, category, description, preparation 
      FROM Services 
      ORDER BY category ASC, name ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching services:', err);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// GET single service by ID
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    const result = await request.query(`
      SELECT id, name, price, duration, category, description, preparation 
      FROM Services 
      WHERE id = @id
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error fetching service:', err);
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

// GET services by category
router.get('/category/:category', verifyToken, async (req, res) => {
  try {
    const request = pool.request();
    request.input('category', sql.VarChar(100), req.params.category);

    const result = await request.query(`
      SELECT id, name, price, duration, category, description, preparation 
      FROM Services 
      WHERE category = @category
      ORDER BY name ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching services by category:', err);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// POST create new service
/*router.post('/', async (req, res) => {
  const { id, name, price, duration, category, description, preparation } = req.body;

  if (!id || !name || price === undefined || duration === undefined || !category) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), id);
    request.input('name', sql.VarChar(255), name);
    request.input('price', sql.Int, price);
    request.input('duration', sql.Int, duration);
    request.input('category', sql.VarChar(100), category);
    request.input('description', sql.VarChar(sql.MAX), description || '');
    request.input('preparation', sql.VarChar(sql.MAX), preparation || '');

    await request.query(`
      INSERT INTO Services (id, name, price, duration, category, description, preparation)
      VALUES (@id, @name, @price, @duration, @category, @description, @preparation)
    `);

    res.status(201).json({ id, name, price, duration, category, description, preparation });
  } catch (err) {
    console.error('Error creating service:', err);
    res.status(500).json({ error: 'Failed to create service' });
  }
}); */

// PUT update service
router.put('/:id', verifyAdmin, async (req, res) => {
  const { name, price, duration, category, description, preparation } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);
    request.input('name', sql.VarChar(255), name);
    request.input('price', sql.Int, price);
    request.input('duration', sql.Int, duration);
    request.input('category', sql.VarChar(100), category);
    request.input('description', sql.VarChar(sql.MAX), description || '');
    request.input('preparation', sql.VarChar(sql.MAX), preparation || '');

    await request.query(`
      UPDATE Services 
      SET name = @name, price = @price, duration = @duration, category = @category, 
          description = @description, preparation = @preparation
      WHERE id = @id
    `);

    res.json({ id: req.params.id, name, price, duration, category, description, preparation });
  } catch (err) {
    console.error('Error updating service:', err);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

// DELETE service
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    await request.query('DELETE FROM Services WHERE id = @id');

    res.json({ message: 'Service deleted successfully' });
  } catch (err) {
    console.error('Error deleting service:', err);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

module.exports = router;

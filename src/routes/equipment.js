const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');

// GET all equipment
router.get('/', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
      FROM Equipment 
      ORDER BY labId ASC, category ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching equipment:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

// GET single equipment by ID
router.get('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    const result = await request.query(`
      SELECT id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
      FROM Equipment 
      WHERE id = @id
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Equipment not found' });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error fetching equipment:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

// GET equipment by lab ID
router.get('/lab/:labId', async (req, res) => {
  try {
    const request = pool.request();
    request.input('labId', sql.VarChar(50), req.params.labId);

    const result = await request.query(`
      SELECT id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
      FROM Equipment 
      WHERE labId = @labId
      ORDER BY category ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching equipment by lab:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

// GET equipment by status
router.get('/status/:status', async (req, res) => {
  try {
    const request = pool.request();
    request.input('status', sql.VarChar(50), req.params.status);

    const result = await request.query(`
      SELECT id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
      FROM Equipment 
      WHERE status = @status
      ORDER BY labId ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching equipment by status:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

// GET equipment requiring maintenance
router.get('/maintenance/pending', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
      FROM Equipment 
      WHERE status IN ('maintenance', 'offline')
      ORDER BY nextService ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching pending maintenance:', err);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

// POST create new equipment
router.post('/', async (req, res) => {
  const { id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes } = req.body;

  if (!id || !labId || !name || !category || !model) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), id);
    request.input('labId', sql.VarChar(50), labId);
    request.input('name', sql.VarChar(255), name);
    request.input('category', sql.VarChar(100), category);
    request.input('model', sql.VarChar(255), model);
    request.input('serialNo', sql.VarChar(100), serialNo || '');
    request.input('status', sql.VarChar(50), status || 'operational');
    request.input('lastCalibrated', sql.VarChar(10), lastCalibrated || '');
    request.input('nextService', sql.VarChar(10), nextService || '');
    request.input('notes', sql.VarChar(sql.MAX), notes || '');

    await request.query(`
      INSERT INTO Equipment (id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes)
      VALUES (@id, @labId, @name, @category, @model, @serialNo, @status, @lastCalibrated, @nextService, @notes)
    `);

    res.status(201).json({ 
      id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
    });
  } catch (err) {
    console.error('Error creating equipment:', err);
    res.status(500).json({ error: 'Failed to create equipment' });
  }
});

// PUT update equipment
router.put('/:id', async (req, res) => {
  const { labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);
    request.input('labId', sql.VarChar(50), labId);
    request.input('name', sql.VarChar(255), name);
    request.input('category', sql.VarChar(100), category);
    request.input('model', sql.VarChar(255), model);
    request.input('serialNo', sql.VarChar(100), serialNo);
    request.input('status', sql.VarChar(50), status);
    request.input('lastCalibrated', sql.VarChar(10), lastCalibrated);
    request.input('nextService', sql.VarChar(10), nextService);
    request.input('notes', sql.VarChar(sql.MAX), notes);

    await request.query(`
      UPDATE Equipment 
      SET labId = @labId, name = @name, category = @category, model = @model, 
          serialNo = @serialNo, status = @status, lastCalibrated = @lastCalibrated, 
          nextService = @nextService, notes = @notes
      WHERE id = @id
    `);

    res.json({ 
      id: req.params.id, labId, name, category, model, serialNo, status, lastCalibrated, nextService, notes 
    });
  } catch (err) {
    console.error('Error updating equipment:', err);
    res.status(500).json({ error: 'Failed to update equipment' });
  }
});

// DELETE equipment
router.delete('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    await request.query('DELETE FROM Equipment WHERE id = @id');

    res.json({ message: 'Equipment deleted successfully' });
  } catch (err) {
    console.error('Error deleting equipment:', err);
    res.status(500).json({ error: 'Failed to delete equipment' });
  }
});

module.exports = router;

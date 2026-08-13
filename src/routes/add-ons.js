const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// GET all premium add-ons
router.get('/', verifyAdmin, async (req, res) => {
  const labId = req.admin.labId
  try {
    const request = pool.request();
    request.input('labId', sql.Int(), labId);
    const result = await request.query(`
      SELECT CAST(a.id AS VARCHAR(20)) AS idx, CAST(a.addOnId AS VARCHAR(20)) AS id, a.labId,  a.name, a.price, b.requiresScheduling, a.description, a.isActive 
    FROM lab_add_ons a inner join lk_add_ons b ON a.addOnId = b.id WHERE a.labId = @labId
      ORDER BY a.price ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching add-ons:', err);
    res.status(500).json({ error: 'Failed to fetch add-ons' });
  }
});

// GET lab add ons
router.post('/labs', verifyToken, async (req, res) => {
  const labIds = Array.isArray(req.body) > 0 ? req.body : []
  try {
    const request = pool.request();
    request.input('labIds', sql.VarChar(50), JSON.stringify(labIds));

    const result = await request.query(`
   SELECT CAST(a.id AS VARCHAR(20)) AS idx, CAST(a.addOnId AS VARCHAR(20)) AS id, a.labId,  a.name, a.price, b.requiresScheduling, a.description, a.isActive 
    FROM lab_add_ons a inner join lk_add_ons b ON a.addOnId = b.id WHERE a.isActive = 1 AND a.labId IN  
    (
      SELECT CAST(value AS INT)
      FROM OPENJSON(@labIds)
    )
    ORDER BY a.price ASC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching add-on:', err);
    res.status(500).json({ error: 'Failed to fetch add-on' });
  }
});

// POST create new add-on
router.post("/", verifyAdmin, async (req, res) => {
 
  const { addOnId, name, price, description, isActive } = req.body;

  if (!addOnId || !name || price === undefined) {
    return res.status(400).json({
      error: "Missing required fields"
    });
  }

  try {
    const request = pool.request();

    request
      .input("addOnId", sql.VarChar(50), String(addOnId).trim())
      .input("labId", sql.Int(), req.admin.labId)
      .input("name", sql.VarChar(255), String(name).trim())
      .input("price", sql.Int, price)
      .input("description", sql.VarChar(sql.MAX), description || "")
      .input("isActive", sql.Bit, isActive);

    const result = await request.query(`
            IF EXISTS (
                SELECT 1
                FROM lab_add_ons
                WHERE addOnId = @addOnId AND labId =@labId
            )
            BEGIN
                SELECT 'DUPLICATE' AS result;
            END
            ELSE
            BEGIN
                INSERT INTO lab_add_ons (
                    addOnId,
                    labId,
                    name,
                    price,
                    description,
                    isActive
                )
                VALUES (
                    @addOnId,
                    @labId,
                    @name,
                    @price,
                    @description,
                    @isActive
                );

                SELECT 'CREATED' AS result;
            END
        `);

    const status = result.recordset[0]?.result;

    if (status === "DUPLICATE") {
      return res.status(409).json({
        success: false,
        error: "duplicate"
      });
    }

    return res.status(201).json({
      success: true
    });

  } catch (err) {
    console.error("Error creating add-on:", err);

    return res.status(500).json({
      error: "Failed to create add-on"
    });
  }
});

// PUT update add-on
router.put('/:id', verifyAdmin, async (req, res) => {
  const { name, price, requiresScheduling, description, isActive } = req.body;
  const id = req.params.id

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);
    request.input('name', sql.VarChar(255), name);
    request.input('price', sql.Int, price);
    request.input('description', sql.VarChar(sql.MAX), description || '');
    request.input('isActive', sql.Bit, isActive)

    await request.query(`
      UPDATE lab_add_ons 
      SET name = @name, price = @price, description = @description, isActive = @isActive
      WHERE id = @id
    `);

    res.json({ id: req.params.id, name, price, requiresScheduling, description });
  } catch (err) {
    console.error('Error updating add-on:', err);
    res.status(500).json({ error: 'Failed to update add-on' });
  }
});

// DELETE add-on
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    await request.query('DELETE FROM lk_add_ons WHERE id = @id');

    res.json({ message: 'Add-on deleted successfully' });
  } catch (err) {
    console.error('Error deleting add-on:', err);
    res.status(500).json({ error: 'Failed to delete add-on' });
  }
});

module.exports = router;

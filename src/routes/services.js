const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');


router.get(
    '/dashboard',
    verifyAdmin,
    async (req, res) => {

        res.json({
            message: 'Welcome Admin',
            labId: req.admin.labId
        });
    }
);
























































// GET all services
router.get('/', async (req, res) => {
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
router.get('/:id', async (req, res) => {
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
router.get('/category/:category', async (req, res) => {
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
router.put('/:id', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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


// Add a new service, only admin can create a new service 
router.post('/', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const {
        name,
        category,
        description,
        price,
        duration,
        preparation
    } = req.body;

    if (!name || !category) {
        return res.status(400).json({ error: 'name and category are required' });
    }
     // begin db transaction to ensure atomimicity
    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        // -----------------------------
        // 1. CREATE GLOBAL SERVICE
        // -----------------------------
        const serviceRequest = new sql.Request(transaction);

        const serviceResult = await serviceRequest
            .input('name', sql.NVarChar(255), name)
            .input('category', sql.NVarChar(255), category)
            .input('description', sql.NVarChar(sql.MAX), description || null)
            .input('createdBy', sql.NVarChar(255), adminId.toString())
            .query(`
                INSERT INTO lk_services
                (name, category, description, isActive, createdBy)
                OUTPUT INSERTED.id, INSERTED.name
                VALUES (@name, @category, @description, 1, @createdBy)
            `);

        const service = serviceResult.recordset[0];

        // -----------------------------
        // 2. CREATE LAB SERVICE
        // -----------------------------
        const labServiceRequest = new sql.Request(transaction);

        const labServiceResult = await labServiceRequest
            .input('labId', sql.Int, labId)
            .input('serviceId', sql.Int, service.id)
            .input('price', sql.Decimal(12, 6), price)
            .input('duration', sql.Int, duration || null)
            .input('preparation', sql.VarChar(500), preparation || null)
            .input('isActive', sql.Bit, 1)
            .input('createdBy', sql.NVarChar(255), adminId.toString())
            .query(`
                INSERT INTO lab_services
                (labId, serviceId, price, duration, preparation, isActive, createdBy)
                OUTPUT INSERTED.*
                VALUES
                (@labId, @serviceId, @price, @duration, @preparation, @isActive, @createdBy)
            `);

        await transaction.commit(); // commit everything together 

        return res.status(201).json({
            success: true,
            data: {
                service: service,
                labService: labServiceResult.recordset[0]
            }
        });

    } catch (err) {

        await transaction.rollback();

        console.error('Error creating service:', err);

        return res.status(500).json({
            error: 'Failed to create service'
        });
    }
});



module.exports = router;

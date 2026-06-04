const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');

// GET all labs
router.get('/', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      ORDER BY distance ASC
    `);

    const labs = result.recordset.map(lab => ({
      ...lab,
      certifications: lab.certifications ? JSON.parse(lab.certifications) : []
    }));

    // For each lab, fetch associated services
    const labsWithServices = await Promise.all(
      labs.map(async (lab) => {
        const servicesRequest = pool.request();
        servicesRequest.input('labId', sql.VarChar(50), lab.id);
        
        const servicesResult = await servicesRequest.query(`
          SELECT s.id, s.name, s.price, s.duration, s.category, s.description, s.preparation
          FROM Services s
          INNER JOIN LabServices ls ON s.id = ls.serviceId
          WHERE ls.labId = @labId
          ORDER BY s.name ASC
        `);

        return {
          ...lab,
          services: servicesResult.recordset
        };
      })
    );

    res.json(labsWithServices);
  } catch (err) {
    console.error('Error fetching labs:', err);
    res.status(500).json({ error: 'Failed to fetch labs' });
  }
});

// GET single lab by ID
router.get('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      WHERE id = @id
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Lab not found' });
    }

    const lab = result.recordset[0];
    lab.certifications = lab.certifications ? JSON.parse(lab.certifications) : [];

    // Fetch associated services
    const servicesRequest = pool.request();
    servicesRequest.input('labId', sql.VarChar(50), req.params.id);
    
    const servicesResult = await servicesRequest.query(`
      SELECT s.id, s.name, s.price, s.duration, s.category, s.description, s.preparation
      FROM Services s
      INNER JOIN LabServices ls ON s.id = ls.serviceId
      WHERE ls.labId = @labId
      ORDER BY s.name ASC
    `);

    lab.services = servicesResult.recordset;

    res.json(lab);
  } catch (err) {
    console.error('Error fetching lab:', err);
    res.status(500).json({ error: 'Failed to fetch lab' });
  }
});

// GET labs by area
router.get('/area/:area', async (req, res) => {
  try {
    const request = pool.request();
    request.input('area', sql.VarChar(100), req.params.area);

    const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      WHERE area = @area
      ORDER BY distance ASC
    `);

    const labs = result.recordset.map(lab => ({
      ...lab,
      certifications: lab.certifications ? JSON.parse(lab.certifications) : []
    }));

    res.json(labs);
  } catch (err) {
    console.error('Error fetching labs by area:', err);
    res.status(500).json({ error: 'Failed to fetch labs' });
  }
});

// GET open labs
router.get('/status/open', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      WHERE isOpen = 1
      ORDER BY distance ASC
    `);

    const labs = result.recordset.map(lab => ({
      ...lab,
      certifications: lab.certifications ? JSON.parse(lab.certifications) : []
    }));

    res.json(labs);
  } catch (err) {
    console.error('Error fetching open labs:', err);
    res.status(500).json({ error: 'Failed to fetch labs' });
  }
});

// POST create new lab
router.post('/', async (req, res) => {
  const { id, name, area, address, distance, rating, reviewCount, openTime, closeTime, isOpen, certifications, phone, image } = req.body;

  if (!id || !name || !area || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), id);
    request.input('name', sql.VarChar(255), name);
    request.input('area', sql.VarChar(100), area);
    request.input('address', sql.VarChar(sql.MAX), address);
    request.input('distance', sql.Float, distance || 0);
    request.input('rating', sql.Float, rating || 0);
    request.input('reviewCount', sql.Int, reviewCount || 0);
    request.input('openTime', sql.VarChar(10), openTime || '');
    request.input('closeTime', sql.VarChar(10), closeTime || '');
    request.input('isOpen', sql.Bit, isOpen || 0);
    request.input('certifications', sql.VarChar(sql.MAX), JSON.stringify(certifications || []));
    request.input('phone', sql.VarChar(20), phone || '');
    request.input('image', sql.VarChar(sql.MAX), image || '');

    await request.query(`
      INSERT INTO Labs (id, name, area, address, distance, rating, reviewCount, openTime, 
                        closeTime, isOpen, certifications, phone, image)
      VALUES (@id, @name, @area, @address, @distance, @rating, @reviewCount, @openTime, 
              @closeTime, @isOpen, @certifications, @phone, @image)
    `);

    res.status(201).json({ 
      id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
      isOpen, certifications, phone, image 
    });
  } catch (err) {
    console.error('Error creating lab:', err);
    res.status(500).json({ error: 'Failed to create lab' });
  }
});

// PUT update lab
router.put('/:id', async (req, res) => {
  const { name, area, address, distance, rating, reviewCount, openTime, closeTime, isOpen, certifications, phone, image } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);
    request.input('name', sql.VarChar(255), name);
    request.input('area', sql.VarChar(100), area);
    request.input('address', sql.VarChar(sql.MAX), address);
    request.input('distance', sql.Float, distance);
    request.input('rating', sql.Float, rating);
    request.input('reviewCount', sql.Int, reviewCount);
    request.input('openTime', sql.VarChar(10), openTime);
    request.input('closeTime', sql.VarChar(10), closeTime);
    request.input('isOpen', sql.Bit, isOpen);
    request.input('certifications', sql.VarChar(sql.MAX), JSON.stringify(certifications || []));
    request.input('phone', sql.VarChar(20), phone);
    request.input('image', sql.VarChar(sql.MAX), image);

    await request.query(`
      UPDATE Labs 
      SET name = @name, area = @area, address = @address, distance = @distance, 
          rating = @rating, reviewCount = @reviewCount, openTime = @openTime, 
          closeTime = @closeTime, isOpen = @isOpen, certifications = @certifications, 
          phone = @phone, image = @image
      WHERE id = @id
    `);

    res.json({ 
      id: req.params.id, name, area, address, distance, rating, reviewCount, openTime, 
      closeTime, isOpen, certifications, phone, image 
    });
  } catch (err) {
    console.error('Error updating lab:', err);
    res.status(500).json({ error: 'Failed to update lab' });
  }
});

// DELETE lab
router.delete('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    await request.query('DELETE FROM Labs WHERE id = @id');

    res.json({ message: 'Lab deleted successfully' });
  } catch (err) {
    console.error('Error deleting lab:', err);
    res.status(500).json({ error: 'Failed to delete lab' });
  }
});

module.exports = router;

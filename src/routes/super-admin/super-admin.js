const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { Float } = require('mssql');
const { verifyAdmin } = require('../../middleware/auth');
const upload = require('../../middleware/upload');



router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const request = pool.request();;
    request.input('email', sql.VarChar(255), email);

    const result = await request.query('SELECT TOP 1 * FROM admins WHERE email = @email');
    const rows = result.recordset;

    if (!rows.length) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const admin = rows[0];
    const passwordMatches = admin.password === password || admin.password_hash === password;
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.email,
        role: admin.role || 'super_admin',
        firstName: admin.first_name || admin.name || 'Admin',
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        email: admin.email,
        role: admin.role || 'super_admin',
        firstName: admin.first_name || admin.name || 'Admin',
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/overview', verifyAdmin, async (_req, res) => {
  try {
    const labsRequest = pool.request();;
    const labsResult = await labsRequest.query('SELECT COUNT(*) AS value FROM labs');

    const usersRequest = pool.request();;
    const usersResult = await usersRequest.query('SELECT COUNT(*) AS value FROM users');

    const onboardingRequest = pool.request();;
    const onboardingResult = await onboardingRequest.query("SELECT COUNT(*) AS value FROM labs WHERE status = 'pending review'");

    const bookingsRequest = pool.request();;
    const bookingsResult = await bookingsRequest.query("SELECT * FROM bookings WHERE status <> 'completed' AND CAST(createdAt AS DATE) = CAST(GETDATE() AS DATE)");

    const revenueRequest = pool.request();;
    const revenueResult = await revenueRequest.query('SELECT COALESCE(SUM(amount), 0) AS value FROM payments');

    res.json({
      totalLabs: Number(labsResult.recordset[0]?.value || 0),
      totalUsers: Number(usersResult.recordset[0]?.value || 0),
      pendingOnboarding: Number(onboardingResult.recordset[0]?.value || 0),
      totalBookings: Number(bookingsResult.recordset[0]?.value || 0),
      totalRevenue: Number(revenueResult.recordset[0]?.value || 0),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/labs', verifyAdmin, async (_req, res) => {
  try {
    const request = pool.request();;
    const result = await request.query(`
      SELECT id, name, location, address, email, status, isActive, onboardedAt as createdAt
      FROM labs
      ORDER BY onboardedAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/labs/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    const request = pool.request();;
    request.input('isActive', sql.Bit, status);
    request.input('id', sql.Int, Number(req.params.id));

    await request.query('UPDATE labs SET isActive = @isActive WHERE id = @id');
    res.json({ success: true, id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/labs/:id', verifyAdmin, async (req, res) => {
  try {
    const request = pool.request();;
    request.input('id', sql.Int, Number(req.params.id));

    await request.query('DELETE FROM labs WHERE id = @id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/users', verifyAdmin, async (_req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, CONCAT(firstName, ' ', lastName) AS name, email, isActive, createdAt
      FROM users
      ORDER BY createdAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/users/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (status < 0) {
      return res.status(400).json({ message: 'Status is required' });
    }
    const isActive = status === true ? 1 : 0

    const request = pool.request();;
    request.input('isActive', sql.Bit, isActive);
    request.input('id', sql.Int, Number(req.params.id));

    await request.query('UPDATE users SET isActive = @isActive WHERE id = @id');
    res.json({ success: true, id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/users/:id', verifyAdmin, async (req, res) => {
  try {
    const request = pool.request();;
    request.input('id', sql.Int, Number(req.params.id));

    await request.query('DELETE FROM users WHERE id = @id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// LAB ADMINS

router.get('/lab-admins', verifyAdmin, async (_req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id, labId, firstName, lastName, email, isActive, createdAt
      FROM lab_admins where isActive = 1
      ORDER BY createdAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


router.post('/lab-admins', verifyAdmin, async (req, res) => {

  const { firstName, lastName, email, phone, password, onboardingId, role, isActive } = req.body;
  const admin = req.admin.email;

  if (!firstName || !lastName || !email || !phone || !password) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();
    const adminCheck = await new sql.Request(transaction)
      .input('labId', sql.Int, onboardingId)
      .input('email', sql.NVarChar(255), email)
      .query(`SELECT email FROM lab_admins WHERE labId = @labId AND email=@email`);

    if (adminCheck.recordset.length > 0) {
      await transaction.rollback();
      return res.status(400).json({ message: 'admin already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const adminInsert = await new sql.Request(transaction)
      .input('labId', sql.Int, onboardingId)
      .input('firstName', sql.NVarChar(255), firstName)
      .input('lastName', sql.NVarChar(255), lastName)
      .input('email', sql.NVarChar(255), email)
      .input('phone', sql.NVarChar(255), phone)
      .input('password', sql.NVarChar(255), passwordHash)
      .input('isActive', sql.Bit, isActive === '1' ? true : false)
      .input('createdBy', sql.NVarChar(255), admin)
      .input('role', sql.NVarChar(255), role)

      .query(`INSERT INTO lab_admins (labId, firstName, lastName, email, phone, role, passwordHash, isActive, createdBy, createdAt) 
        OUTPUT INSERTED.id
        VALUES 
        (@labId, @firstName, @lastName, @email, @phone, @role, @password, @isActive, @createdBy, GETDATE())`);

    const adminInsertId = adminInsert.recordset[0].id;
    await transaction.commit();

    return res.status(201).json({
      adminInsertId: adminInsertId,
      success: true,
      message: 'Admin added successfully'
    });

  } catch (err) {
    if (transaction._aborted !== true) {
      await transaction.rollback();
    }
    console.log(err)
    return res.status(500).json({ error: 'Failed to add admin' });
  }

});

router.patch('/lab-admins/:id', verifyAdmin, async (req, res) => {
  const id = req.params.id
  const { firstName, lastName, email, phone, password, onboardingId, role, isActive } = req.body;
  const admin = req.admin.email;

  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    await new sql.Request(transaction)
      .input('id', sql.Int, id)
      .input('firstName', sql.NVarChar(255), firstName)
      .input('lastName', sql.NVarChar(255), lastName)
      .input('phone', sql.NVarChar(255), phone)
      .input('isActive', sql.Bit, isActive === '1' ? true : false)
      .input('createdBy', sql.NVarChar(255), admin)
      .input('role', sql.NVarChar(255), role)

      .query(`UPDATE lab_admins SET firstName=@firstName, lastName=@lastName, phone=@phone, role=@role, isActive=@isActive, createdBy=@createdBy, createdAt=GETDATE() WHERE id = @id `);


    await transaction.commit();

    return res.status(201).json({
      success: true,
      message: 'Admin updated successfully'
    });

  } catch (err) {
    if (transaction._aborted !== true) {
      await transaction.rollback();
    }
    console.log(err)
    return res.status(500).json({ error: 'Failed to update admin' });
  }

});

router.delete('/lab-admins/:id', verifyAdmin, async (req, res) => {
  try {
    const request = pool.request();;
    request.input('id', sql.Int, Number(req.params.id));

    await request.query('DELETE FROM lab_admins WHERE id = @id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET LABS
router.get('/onboarding', verifyAdmin, async (_req, res) => {
  try {
    const request = pool.request();;
    let labs = await request.query(`
      SELECT *, name AS labName, onboardedAt AS createdAt FROM labs
      ORDER BY onboardedAt DESC
    `);

    let documents = await request.query(`
      SELECT id, labId, documentType, fileUrl  FROM lab_documents 
    `);

    let lab_admins = await request.query(`
      SELECT id, labId, firstName, lastName, email, phone, role, isActive, createdAt FROM lab_admins 
    `);

    labs = labs.recordset
    documents = documents.recordset
    lab_admins = lab_admins.recordset

    for (const l in labs) {
      const lab = labs[l]
      const docs = documents?.filter(l => parseInt(l.labId) === parseInt(lab.id)) ?? []
      const admins = lab_admins?.filter(l => parseInt(l.labId) === parseInt(lab.id)) ?? []
      lab.documents = docs
      lab.lab_admins = admins
    }

    res.json(labs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/onboarding/:labId', verifyAdmin, async (req, res) => {
  const labId = req.params.labId
  try {
    const request = pool.request();
    request.input('labId', sql.VarChar(255), labId);
    let labs = await request.query(`
      SELECT *, name AS labName, onboardedAt AS createdAt FROM labs WHERE id = @labId
      ORDER BY onboardedAt DESC
    `);

    let documents = await request.query(`
      SELECT id, labId, documentType, fileUrl  FROM lab_documents WHERE labId = @labId
    `);

    let lab_admins = await request.query(`
      SELECT id, labId, firstName, lastName, email, phone, role, isActive, createdAt FROM lab_admins WHERE labId = @labId
    `);

    labs = labs.recordset
    documents = documents.recordset
    lab_admins = lab_admins.recordset

    for (const l in labs) {
      const lab = labs[l]
      const docs = documents?.filter(l => parseInt(l.labId) === parseInt(lab.id)) ?? []
      const admins = lab_admins?.filter(l => parseInt(l.labId) === parseInt(lab.id)) ?? []
      lab.documents = docs
      lab.lab_admins = admins
    }

    res.json(labs);
  } catch (err) {
    console.log(err)
    res.status(500).json({ message: err.message });
  }
});


// ADD new lab
router.post('/onboarding', verifyAdmin, async (req, res) => {
  try {
    const payload = req.body;
    const request = pool.request();
    const admin = req.admin.email;


    request.input('name', sql.VarChar(255), payload.labName);
    request.input('address', sql.VarChar(500), payload.address);
    request.input('state', sql.VarChar(255), payload.state);
    request.input('lga', sql.VarChar(255), payload.lga);
    request.input('area', sql.VarChar(255), payload.area);
    request.input('latitude', sql.Decimal(10, 8), payload.latitude);
    request.input('longitude', sql.Decimal(11, 8), payload.longitude);
    request.input('email', sql.VarChar(255), payload.email);
    request.input('phone', sql.VarChar(50), payload.phone);
    request.input('certifications', sql.NVarChar(4000), payload.certifications);
    request.input('openTime', sql.VarChar(20), payload.openingTime);
    request.input('closeTime', sql.VarChar(20), payload.closingTime);
    request.input('status', sql.VarChar(50), payload.approvalStatus || 'pending review');
    request.input('reviewNotes', sql.VarChar(5000), payload.reviewNotes);
    request.input('bankName', sql.VarChar(255), payload.bankName);
    request.input('accountName', sql.VarChar(255), payload.accountName);
    request.input('accountNumber', sql.VarChar(100), payload.accountNumber);
    request.input('notes', sql.VarChar(5000), payload.notes);
    request.input('onboardedBy', sql.NVarChar(50), admin);
    request.input('licenseNumber', sql.VarChar(255), payload.licenseNumber)

    const labInsert = await request.query(`
      INSERT INTO labs (
        name, address, area, state, lga, latitude, longitude, location, openTime, closeTime, certifications, isActive, isOpen, email, phone, status, reviewNotes, notes, bankName, accountName, accountNumber, onboardedAt, onboardedBy, distance, rating, reviewCount, licenseNumber 
      ) 
      OUTPUT INSERTED.id
      VALUES 
      (
        @name, @address, @area, @state, @lga, @latitude, @longitude, geography::Point(@latitude, @longitude, 4326), @openTime, @closeTime, @certifications, 0, 0, @email, @phone, @status, @reviewNotes, @notes, @bankName, @accountName, @accountNumber, GETDATE(), @onboardedBy, 0, 4.0, 0, @licenseNumber
      )
    `);
    const labInsertId = labInsert.recordset[0].id;
    res.status(201).json({ success: true, labInsertId: labInsertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/onboarding/documents', verifyAdmin, upload.single('document'), async (req, res) => {
  const adminId = req.admin.adminId;
  const { labId, type } = req.body
  const file = req.file;
  const documentType = req.file.originalname

  if (!labId) {
    return res.status(400).json({ error: 'labId is required' });
  }

  if (!file) {
    return res.status(400).json({ error: 'document file is required' });
  }

  const transaction = new sql.Transaction(pool);

  const query =
    type === "certification" ?
      `INSERT INTO lab_documents 
    (labId, documentType, fileUrl, fileType, fileSizeBytes, createdBy, createdAt)
    VALUES
    (@labId, @documentType, @fileUrl, @fileType, @fileSizeBytes, @createdBy, GETDATE()) `
      :
      `UPDATE labs SET image = @fileUrl WHERE id = @labId`;

  try {
    await transaction.begin();
    const labCheck = await new sql.Request(transaction)
      .input('labId', sql.Int, labId)
      .query(`SELECT id FROM labs WHERE id = @labId `);

    if (labCheck.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ error: 'lab not found' });
    }

    const fileUrl = file.location || `/uploads/${file.filename}`; // Handles both S3 and local

    const documentInsert = await new sql.Request(transaction)
      .input('labId', sql.Int, labId)
      .input('documentType', sql.NVarChar(255), documentType)
      .input('fileUrl', sql.NVarChar(500), fileUrl)
      .input('fileType', sql.NVarChar(100), file.mimetype)
      .input('fileSizeBytes', sql.Int, file.size)
      .input('createdBy', sql.NVarChar(255), adminId.toString())
      .query(query);


    await transaction.commit();

    return res.status(201).json({
      success: true,
      message: 'Test result document uploaded successfully',
      data: {
        fileUrl,
        labId
      }
    });

  } catch (err) {
    if (transaction._aborted !== true) {
      await transaction.rollback();
    }
    console.error('Test result upload error:', err);
    return res.status(500).json({ error: 'Failed to upload test result document' });
  }
});



// UPDATE LAB onboarding
router.patch('/onboarding/:id', verifyAdmin, async (req, res) => {
  try {
    const { approvalStatus, reviewNotes } = req.body;
    const fields = [];
    const request = pool.request();;

    if (approvalStatus !== undefined) {
      request.input('approvalStatus', sql.VarChar(50), approvalStatus);
      fields.push('status = @approvalStatus');
    }
    if (reviewNotes !== undefined) {
      request.input('reviewNotes', sql.NVarChar(4000), reviewNotes);
      fields.push('notes = @reviewNotes');
    }

    if (!fields.length) {
      return res.status(400).json({ message: 'No update fields supplied' });
    }

    request.input('id', sql.Int, Number(req.params.id));
    await request.query(`UPDATE labs SET ${fields.join(', ')} WHERE id = @id`);
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// REMOVE LABS
router.delete('/onboarding/:id', verifyAdmin, async (req, res) => {
  try {
    const request = pool.request();;
    request.input('id', sql.Int, Number(req.params.id));

    await request.query('DELETE FROM labs WHERE id = @id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



router.get('/billing', verifyAdmin, async (_req, res) => {
  try {
    const request = pool.request();;
    const result = await request.query(`
      SELECT a.id, b.labId, c.name as labName, a.ref, a.amount, a.currency, a.status, a.createdAt
      FROM payments a  INNER JOIN bookings b ON a.ref = b.ref
      INNER JOIN labs c ON b.labId = c.id
      ORDER BY a.createdAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
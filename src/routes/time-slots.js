const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { formatTime, formatDate } = require('../middleware/helpers');


router.post('/lab-dates', async (req, res) => {
  let labIds = req.body.join(',')
  try {
    const request = pool.request();
    request.input('labIds', sql.VarChar(50), labIds);

    const result = await request.query(`SELECT id, labId, slotDate, timeSlot, isAvailable, capacity FROM time_slot_availability WHERE labId in (${labIds}) AND slotDate >= CAST(GETDATE() AS DATE) AND isAvailable=1`);
    const dates = result.recordset
    res.json(dates.map(row => ({
      ...row,
      slotDate: formatDate(row.slotDate),
      timeSlot: formatTime(row.timeSlot)
    })));
  } catch (err) {
    console.error('Error fetching time slots:', err);
    res.status(500).json({ error: 'Failed to fetch time slots' });
  }
});


router.post('/lab-times', async (req, res) => {
  let { labId, slotDate } = req.body

  try {
    const request = pool.request();
    request.input('labId', sql.Int, labId);
    request.input('slotDate', sql.DateTime2, slotDate);

    const result = await request.query(`SELECT distinct labId, slotDate, timeSlot FROM time_slot_availability WHERE labId = @labId AND slotDate >= CAST(@slotDate AS DATE) AND isAvailable = 1`);
    const _times = result.recordset
    res.json(_times.map(row => ({
      ...row,
      slotDate: formatDate(row.slotDate)
    })));
  } catch (err) {
    console.error('Error fetching time slots:', err);
    res.status(500).json({ error: 'Failed to fetch time slots' });
  }
});


// GET all available time slots
router.get('/', async (req, res) => {
  try {
    // Return predefined time slots
    const timeSlots = [
      "07:30", "08:00", "08:30", "09:00", "09:30", "10:00",
      "10:30", "11:00", "11:30", "12:00", "13:00", "13:30",
      "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
      "17:00", "17:30", "18:00",
    ];

    res.json(timeSlots);
  } catch (err) {
    console.error('Error fetching time slots:', err);
    res.status(500).json({ error: 'Failed to fetch time slots' });
  }
});

// GET available time slots for a lab on specific date
router.get('/lab/:labId/date/:date', async (req, res) => {
  try {
    const request = pool.request();
    request.input('labId', sql.VarChar(50), req.params.labId);
    request.input('date', sql.VarChar(10), req.params.date);

    const result = await request.query(`
      SELECT DISTINCT timeSlot 
      FROM TimeSlotAvailability 
      WHERE labId = @labId AND date = @date AND isAvailable = 1
      ORDER BY timeSlot ASC
    `);

    const slots = result.recordset.map(r => r.timeSlot);
    res.json(slots.length > 0 ? slots : getAllDefaultSlots());
  } catch (err) {
    console.error('Error fetching available time slots:', err);
    res.status(500).json({ error: 'Failed to fetch time slots' });
  }
});

// Helper function to get default time slots
function getAllDefaultSlots() {
  return [
    "07:30", "08:00", "08:30", "09:00", "09:30", "10:00",
    "10:30", "11:00", "11:30", "12:00", "13:00", "13:30",
    "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
    "17:00", "17:30", "18:00",
  ];
}

// POST create time slot availability (admin)
router.post('/availability', async (req, res) => {
  const { labId, date, timeSlot, isAvailable } = req.body;

  if (!labId || !date || !timeSlot || isAvailable === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = pool.request();
    request.input('labId', sql.VarChar(50), labId);
    request.input('date', sql.VarChar(10), date);
    request.input('timeSlot', sql.VarChar(10), timeSlot);
    request.input('isAvailable', sql.Bit, isAvailable);

    await request.query(`
      INSERT INTO TimeSlotAvailability (labId, date, timeSlot, isAvailable)
      VALUES (@labId, @date, @timeSlot, @isAvailable)
    `);

    res.status(201).json({ labId, date, timeSlot, isAvailable });
  } catch (err) {
    console.error('Error creating time slot:', err);
    res.status(500).json({ error: 'Failed to create time slot' });
  }
});

// PUT update time slot availability
router.put('/availability/:id', async (req, res) => {
  const { isAvailable } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.Int, req.params.id);
    request.input('isAvailable', sql.Bit, isAvailable);

    await request.query(`
      UPDATE TimeSlotAvailability 
      SET isAvailable = @isAvailable
      WHERE id = @id
    `);

    res.json({ id: req.params.id, isAvailable });
  } catch (err) {
    console.error('Error updating time slot:', err);
    res.status(500).json({ error: 'Failed to update time slot' });
  }
});

module.exports = router;

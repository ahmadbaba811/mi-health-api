const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');

// Helper function to fetch full booking details with nested lab and services
async function getFullBooking(bookingId) {
  // Fetch booking
  const bookingRequest = pool.request();
  bookingRequest.input('id', sql.VarChar(50), bookingId);
  
  const bookingResult = await bookingRequest.query(`
    SELECT id, ref, labId, date, time, status, total, createdAt, addOns, isWalkIn, homeAddress 
    FROM Bookings 
    WHERE id = @id
  `);

  if (bookingResult.recordset.length === 0) {
    return null;
  }

  const booking = bookingResult.recordset[0];
  booking.addOns = booking.addOns ? JSON.parse(booking.addOns) : [];

  // Fetch lab with its services
  const labRequest = pool.request();
  labRequest.input('labId', sql.VarChar(50), booking.labId);
  
  const labResult = await labRequest.query(`
    SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
           isOpen, certifications, phone, image 
    FROM Labs 
    WHERE id = @labId
  `);

  if (labResult.recordset.length > 0) {
    const lab = labResult.recordset[0];
    lab.certifications = lab.certifications ? JSON.parse(lab.certifications) : [];

    // Fetch lab services
    const labServicesRequest = pool.request();
    labServicesRequest.input('labId', sql.VarChar(50), booking.labId);
    
    const labServicesResult = await labServicesRequest.query(`
      SELECT s.id, s.name, s.price, s.duration, s.category, s.description, s.preparation
      FROM Services s
      INNER JOIN LabServices ls ON s.id = ls.serviceId
      WHERE ls.labId = @labId
      ORDER BY s.name ASC
    `);

    lab.services = labServicesResult.recordset;
    booking.lab = lab;
  }

  // Fetch services for this booking
  const servicesRequest = pool.request();
  servicesRequest.input('bookingId', sql.VarChar(50), bookingId);
  
  const servicesResult = await servicesRequest.query(`
    SELECT s.id, s.name, s.price, s.duration, s.category, s.description, s.preparation
    FROM Services s
    INNER JOIN BookingServices bs ON s.id = bs.serviceId
    WHERE bs.bookingId = @bookingId
  `);

  booking.services = servicesResult.recordset;

  return booking;
}

// GET all bookings
router.get('/', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT id FROM Bookings 
      ORDER BY createdAt DESC
    `);

    const bookings = await Promise.all(
      result.recordset.map(row => getFullBooking(row.id))
    );

    res.json(bookings);
  } catch (err) {
    console.error('Error fetching bookings:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET single booking by ID
router.get('/:id', async (req, res) => {
  try {
    const booking = await getFullBooking(req.params.id);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(booking);
  } catch (err) {
    console.error('Error fetching booking:', err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// GET bookings by status
router.get('/status/:status', async (req, res) => {
  try {
    const request = pool.request();
    request.input('status', sql.VarChar(50), req.params.status);

    const result = await request.query(`
      SELECT id FROM Bookings 
      WHERE status = @status
      ORDER BY createdAt DESC
    `);

    const bookings = await Promise.all(
      result.recordset.map(row => getFullBooking(row.id))
    );

    res.json(bookings);
  } catch (err) {
    console.error('Error fetching bookings by status:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// POST create new booking
router.post('/', async (req, res) => {
  const { id, ref, labId, date, time, status, total, createdAt, addOns, isWalkIn, homeAddress, services } = req.body;

  if (!id || !ref || !labId || !total) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), id);
    request.input('ref', sql.VarChar(50), ref);
    request.input('labId', sql.VarChar(50), labId);
    request.input('date', sql.VarChar(10), date || '');
    request.input('time', sql.VarChar(10), time || '');
    request.input('status', sql.VarChar(50), status || 'upcoming');
    request.input('total', sql.Int, total);
    request.input('createdAt', sql.VarChar(10), createdAt || new Date().toISOString().split('T')[0]);
    request.input('addOns', sql.VarChar(sql.MAX), JSON.stringify(addOns || []));
    request.input('isWalkIn', sql.Bit, isWalkIn || 0);
    request.input('homeAddress', sql.VarChar(sql.MAX), homeAddress || '');

    await request.query(`
      INSERT INTO Bookings (id, ref, labId, date, time, status, total, createdAt, addOns, isWalkIn, homeAddress)
      VALUES (@id, @ref, @labId, @date, @time, @status, @total, @createdAt, @addOns, @isWalkIn, @homeAddress)
    `);

    // Insert booking services
    if (services && Array.isArray(services)) {
      for (const serviceId of services) {
        const serviceRequest = pool.request();
        serviceRequest.input('bookingId', sql.VarChar(50), id);
        serviceRequest.input('serviceId', sql.VarChar(50), serviceId);
        await serviceRequest.query(`
          INSERT INTO BookingServices (bookingId, serviceId)
          VALUES (@bookingId, @serviceId)
        `);
      }
    }

    res.status(201).json({ 
      id, ref, labId, date, time, status, total, createdAt, addOns, isWalkIn, homeAddress, services 
    });
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// PUT update booking
router.put('/:id', async (req, res) => {
  const { ref, labId, date, time, status, total, addOns, isWalkIn, homeAddress, services } = req.body;

  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);
    request.input('ref', sql.VarChar(50), ref);
    request.input('labId', sql.VarChar(50), labId);
    request.input('date', sql.VarChar(10), date);
    request.input('time', sql.VarChar(10), time);
    request.input('status', sql.VarChar(50), status);
    request.input('total', sql.Int, total);
    request.input('addOns', sql.VarChar(sql.MAX), JSON.stringify(addOns || []));
    request.input('isWalkIn', sql.Bit, isWalkIn);
    request.input('homeAddress', sql.VarChar(sql.MAX), homeAddress);

    await request.query(`
      UPDATE Bookings 
      SET ref = @ref, labId = @labId, date = @date, time = @time, status = @status, 
          total = @total, addOns = @addOns, isWalkIn = @isWalkIn, homeAddress = @homeAddress
      WHERE id = @id
    `);

    // Update booking services if provided
    if (services && Array.isArray(services)) {
      const deleteRequest = pool.request();
      deleteRequest.input('bookingId', sql.VarChar(50), req.params.id);
      await deleteRequest.query('DELETE FROM BookingServices WHERE bookingId = @bookingId');

      for (const serviceId of services) {
        const serviceRequest = pool.request();
        serviceRequest.input('bookingId', sql.VarChar(50), req.params.id);
        serviceRequest.input('serviceId', sql.VarChar(50), serviceId);
        await serviceRequest.query(`
          INSERT INTO BookingServices (bookingId, serviceId)
          VALUES (@bookingId, @serviceId)
        `);
      }
    }

    res.json({ 
      id: req.params.id, ref, labId, date, time, status, total, addOns, isWalkIn, homeAddress, services 
    });
  } catch (err) {
    console.error('Error updating booking:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// DELETE booking
router.delete('/:id', async (req, res) => {
  try {
    const request = pool.request();
    request.input('id', sql.VarChar(50), req.params.id);

    // Delete booking services first
    const deleteServicesRequest = pool.request();
    deleteServicesRequest.input('bookingId', sql.VarChar(50), req.params.id);
    await deleteServicesRequest.query('DELETE FROM BookingServices WHERE bookingId = @bookingId');

    // Delete booking
    await request.query('DELETE FROM Bookings WHERE id = @id');

    res.json({ message: 'Booking deleted successfully' });
  } catch (err) {
    console.error('Error deleting booking:', err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

module.exports = router;

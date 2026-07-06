const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken } = require('../middleware/auth');

const HOLD_MINUTES = 10;

// Result codes returned by stored procedures
const RESULT = {
    SUCCESS: 0,
    SLOT_FULL: 1,
    SLOT_NOT_FOUND: 2,
    HOLD_EXPIRED_OR_INVALID: 1,
};


// Helper function to fetch full booking details with nested lab and services
async function getFullBooking({ bookingId, userId }) {

    const bookingRequest = pool.request();

    bookingRequest.input('id', sql.Int, bookingId || null);
    bookingRequest.input('userId', sql.Int, userId || null);

    const bookingResult = await bookingRequest.query(`
       SELECT id, id as bookingId, userId, ref, labId, totalPrice as total, status, isWalkIn, date, time, homeAddress, postCode, addOns, createdAt from bookings
       WHERE ${bookingId ? 'id = @id' : 'userId = @userId'}
    `);

    if (bookingResult.recordset.length === 0) {
        return [];
    }

    const bookings = bookingResult.recordset;

    for (const booking of bookings) {

        booking.addOns = booking.addOns
            ? booking.addOns.split(',')
            : [];
        booking.id = booking.id.toString();
        booking.bookingId = booking.bookingId.toString();

        // ==========================
        // Fetch Lab
        // ==========================

        const labRequest = pool.request();
        labRequest.input('labId', sql.Int, booking.labId);

        const labResult = await labRequest.query(`
            SELECT id, name, area, lga, state, address, distance, rating, reviewCount, openTime, closeTime, isOpen, certifications, phone, image FROM Labs WHERE id = @labId
        `);

        if (labResult.recordset.length > 0) {
            const lab = labResult.recordset[0];
            lab.certifications = lab.certifications
                ? lab.certifications.split(',').map(x => x.trim())
                : [];
            // ==========================
            // Fetch Lab Services
            // ==========================

            const labServicesRequest = pool.request();
            labServicesRequest.input('labId', sql.Int, booking.labId);

            const labServicesResult = await labServicesRequest.query(`
                SELECT s.id, ls.serviceId as labServiceId, s.name, ls.price, ls.duration, s.category,
                s.description, ls.preparation FROM lk_services s
                INNER JOIN lab_services ls ON s.id = ls.serviceId
                WHERE ls.labId = @labId
                ORDER BY s.name ASC
            `);

            lab.services = labServicesResult.recordset;

            booking.lab = lab;
        }

        // ==========================
        // Fetch Booking Services
        // ==========================

        const servicesRequest = pool.request();
        servicesRequest.input('bookingId', sql.Int, booking.bookingId);

        const servicesResult = await servicesRequest.query(`
            SELECT b.id, ls.labId, b.labServiceId, s.name, b.price, ls.duration, s.category, s.description, ls.preparation FROM lk_services s 
            INNER JOIN lab_services ls on s.id = ls.serviceId 
            INNER JOIN booking_services b on b.labserviceId  = ls.id
            WHERE b.bookingId = @bookingId
        `);

        booking.services = servicesResult.recordset;
    }

    return bookings;
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
router.post('/id', async (req, res) => {
    const bookingId = req.body.bookingId;
    const userId = req.body.userId;
    try {
        const booking = await getFullBooking({ bookingId, userId });

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

// POST hold booking for 10 minutes
router.post('/hold', async (req, res) => {
    const { userId, labId, slotDate, timeSlot } = req.body;
    if (!userId || !labId || !slotDate || !timeSlot) {
        console.log('here')
        return res.status(400).json({ error: 'labId, slotDate and timeSlot are required.' });
    }

    try {
        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .input('labId', sql.Int, labId)
            .input('slotDate', sql.Date, new Date(slotDate))
            .input('timeSlot', sql.Time(0), timeSlot)
            .input('holdMinutes', sql.Int, HOLD_MINUTES)
            .execute('usp_hold_slot');

        const row = result.recordset[0];

        switch (row.resultCode) {
            case RESULT.SUCCESS:
                return res.status(200).json({
                    holdId: row.holdId,
                    expiresAt: row.expiresAt,
                    expiresInSeconds: HOLD_MINUTES * 60,
                    message: `Slot held for ${HOLD_MINUTES} minutes. Complete your booking before it expires.`,
                });

            case RESULT.SLOT_FULL:
                return res.status(409).json({ error: 'This time slot is fully booked. Please choose another.' });

            case RESULT.SLOT_NOT_FOUND:
                return res.status(404).json({ error: 'Time slot not found or is unavailable.' });

            default:
                return res.status(500).json({ error: 'Unexpected error reserving slot.' });
        }
    } catch (err) {
        console.error('[holdSlot] DB error:', err);
        return res.status(500).json({ error: 'Failed to reserve slot. Please try again.' });
    }
})

// POST confirm booking i.e convert held booking to full booking after payment
router.post('/confirm', async (req, res) => {
    const bookings = req.body.data;
    const dt = req.body;
    const { subTotal, addOnsTotal } = req.body
    const labOnlySubTotal = subTotal

    const user = req.body.user
    const results_array = []

    let lineItems = [];
    if (bookings.length > 0) {
        await Promise.all(bookings.map(async (b, index) => {
            const userId = user.user.id;
            const { id: labId } = b.lab;
            const services = b.services;
            const addOns = b.addOns?.join(", ");
            const { holdId, ref, isWalkIn, status } = b;
            const slotDate = b.date === "" ? null : b.date
            const slotTime = b.time === "" ? null : b.time
            const homeAddress = b.homeAddress ?? null;
            const postCode = b.postCode ?? null;
            const totalPrice = b.total
            const labServiceTotal = b.labServiceTotal
            const labAddOnDetails = b.labAddOnDetails
            
            // Basic validation
            if (!labId || !totalPrice || !Array.isArray(services) || !services.length) {
                // return res.status(400).json({ error: 'Missing required booking fields.' });
                console.log(ref, 400, 'Missing required booking fields.', holdId, labId, totalPrice, slotDate, slotTime, Array.isArray(services), services.length)
                results_array.push({
                    status: 400,
                    error: 'Missing required booking fields.'
                })
            }

            if (totalPrice <= 0) {
                // return res.status(400).json({ error: 'totalPrice must be non-negative.' });
                console.log(ref, 400, 'totalPrice must be non-negative.')
                results_array.push({
                    status: 400,
                    error: 'totalPrice must be non-negative.'
                })
            }

            try {
                const result = await pool.request()
                    .input('holdId', sql.Int, holdId)
                    .input('userId', sql.Int, userId)
                    .input('ref', sql.NVarChar(50), ref ?? null)
                    .input('walkInLabId', sql.Int, labId)
                    .input('totalPrice', sql.Decimal(12, 6), totalPrice)
                    .input('isWalkIn', sql.Bit, isWalkIn ? 1 : 0)
                    .input('homeAddress', sql.NVarChar(sql.MAX), homeAddress ?? null)
                    .input('postCode', sql.NVarChar(50), postCode ?? null)
                    .input('addOns', sql.NVarChar(50), addOns ?? null)
                    .input('createdBy', sql.NVarChar(255), String(userId))
                    .input('services', sql.NVarChar(sql.MAX), JSON.stringify(services))
                    .input('gatewayProvider', sql.NVarChar(50), ref)
                    .input('gatewayTransactionId', sql.NVarChar(50), ref)
                    .execute('usp_confirm_booking');

                const row = result.recordset[0];


                if (row.resultCode === RESULT.SUCCESS) {
                    lineItems.push({ bookingId: row.bookingId, amount: labServiceTotal, type: "lab_subtotal", description: `Booking fee for ${b.lab.name}`, addOnId: null })

                    const add_ons_items = labAddOnDetails?.map(x => {
                        return { bookingId: row.bookingId, amount: x.price, type: "lab_add_on", description: `Add On fee for ${b.lab.name}`, addOnId: x.id }
                    })
                    lineItems.push(...add_ons_items)

                    results_array.push({
                        status: 201,
                        bookingId: row.bookingId,
                        message: 'Booking confirmed successfully.',
                        labId: labId
                    })
                }


                if (row.resultCode === RESULT.HOLD_EXPIRED_OR_INVALID) {
                    if (isWalkIn === false) {
                        console.log(ref, '410', 'Your slot reservation has expired')
                        results_array.push({
                            status: 410,
                            error: 'Your slot reservation has expired or is invalid. Please select a new time slot.',
                            labId: labId
                        })
                    }
                }
                if (row.resultCode === 5) {
                    console.log(ref, '410', 'This payment has already been processed.')
                    results_array.push({
                        status: 410,
                        error: 'This booking has already been processed.',
                        labId: labId
                    })
                }

            } catch (err) {
                console.error('[confirmBooking] DB error:', err);
                results_array.push({
                    status: 500,
                    error: 'Failed to confirm booking. Please try again.',
                    labId: labId
                })
            }

            if (index + 1 === bookings.length) {
                const booking_outcome = results_array[0]

                // RECORD PAYMENTS BEFORE SENDING BACK RESPONSE
                
                if (booking_outcome?.status === 201) {
                    const result = await pool.request()
                        .input('ref', sql.NVarChar(50), ref ?? null)
                        .input('userId', sql.Int, userId)
                        .input('labId', sql.Int, labId)
                        .input('subTotal', sql.Decimal(12, 6), totalPrice)
                        .input('currency', sql.NVarChar(50), "NGN")
                        .input('paymentMethod', sql.NVarChar(50), "paystack")
                        .input('gatewayProvider', sql.NVarChar(50), ref)
                        .input('gatewayTransactionId', sql.NVarChar(50), ref)
                        .input('gatewayReference', sql.NVarChar(50), ref)
                        .input('serviceFee', sql.Decimal(12, 6), dt.serviceFee)
                        .input('VAT', sql.Decimal(12, 6), dt.vat)
                        .input('createdBy', sql.NVarChar(255), String(userId))
                        .input('lineItems', sql.NVarChar(sql.MAX), JSON.stringify(lineItems))
                        .execute('usp_record_payment');

                    const row = result.recordset[0];

                    if (row.resultCode !== 0) {
                        console.log(row)
                        // SEND ADMIN AN EMAIL NOTIFICATION WITH THE FAILED PAYMENT RECORD DETAILS
                        const b = { lineItems: lineItems, vat: dt.vat, serviceFee: dt.serviceFee }
                    }
                }
                res.json(results_array)
            }
        }))
    } else {
        res.json([{
            status: 404,
            error: 'No bookings to confirm.'
        }])
    }
})


// POST update booking date and time
router.put('/update-booking', async (req, res) => {

    const booking = req.body.data;
    const user = req.body.user;
    const userId = user.user.id;

    const { id: labId } = booking.lab;
    const { bookingId, newHoldId } = booking;

    if (!bookingId || !newHoldId || !labId) {
        return res.status(400).json({
            error: 'Missing required fields: bookingId, newHoldId and labId are required.'
        });
    }

    try {
        const result = await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .input('newHoldId', sql.Int, newHoldId)
            .input('userId', sql.Int, userId)
            .input('labId', sql.Int, labId)
            .execute('usp_update_booking');

        const row = result.recordset[0];

        switch (row.resultCode) {
            case 0:
                return res.status(200).json({
                    bookingId,
                    message: row.reason,
                    labId
                });

            case 1:
                return res.status(404).json({ error: row.reason, labId });

            case 2:
                return res.status(410).json({ error: row.reason, labId });

            case 3:
                return res.status(400).json({ error: row.reason, labId });

            case 4:
                return res.status(409).json({ error: row.reason, labId });

            default:
                return res.status(500).json({ error: 'Unexpected error updating booking.' });
        }

    } catch (err) {
        console.error('[updateBooking] DB error:', err);
        return res.status(500).json({ error: 'Failed to update booking. Please try again.' });
    }
});


router.post('/cancel-booking', async (req, res) => {
    const booking = req.body.data;
    const user = req.body.user;
    const userId = user.user.id;

    const { id: labId } = booking.lab;
    const { bookingId } = booking;

    if (!bookingId || !labId) {
        return res.status(400).json({
            error: 'Missing required fields: bookingId and labId are required.'
        });
    }

    try {
        const result = await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .input('userId', sql.Int, userId)
            .input('labId', sql.Int, labId)
            .execute('usp_cancel_booking');

        const row = result.recordset[0];

        switch (row.resultCode) {
            case 0:
                return res.status(200).json({
                    bookingId,
                    message: row.reason,
                    labId
                });

            case 1:
                return res.status(404).json({ error: row.reason, labId });

            default:
                return res.status(500).json({ error: 'Unexpected error cancelling booking.' });
        }

    } catch (err) {
        console.error('[cancelBooking] DB error:', err);
        return res.status(500).json({ error: 'Failed to cancel booking. Please try again.' });
    }
});

// POST create new booking
/*router.post('/', async (req, res) => {
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
}); */





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







//post create a new booking, only authenticated users can create a new booking
router.post('/addbooking', verifyToken, async (req, res) => {

    const userId = req.user.userId;

    const {
        serviceId,
        labId,
        serviceType,
        isWalkIn,
        date,
        time,
        homeAddress,
        addOns
    } = req.body;

    const addOnsValue =
        Array.isArray(addOns)
            ? JSON.stringify(addOns)
            : null;

    // -------------------------
    // Validation
    // -------------------------

    if (!serviceId) {
        return res.status(400).json({
            error: 'serviceId is required'
        });
    }

    if (!labId) {
        return res.status(400).json({
            error: 'labId is required'
        });
    }

    if (!date || !time) {
        return res.status(400).json({
            error: 'date and time are required'
        });
    }

    const transaction = new sql.Transaction(pool);

    try {

        await transaction.begin();

        // -----------------------------------
        // Verify Lab Service Exists
        // -----------------------------------

        const labServiceResult =
            await new sql.Request(transaction)
                .input('labId', sql.Int, labId)
                .input('serviceId', sql.Int, serviceId)
                .query(`
                    SELECT
                        id,
                        price
                    FROM lab_services
                    WHERE labId = @labId
                    AND serviceId = @serviceId
                    AND isActive = 1
                `);

        if (labServiceResult.recordset.length === 0) {

            await transaction.rollback();

            return res.status(404).json({
                error: 'Service not available for this lab'
            });
        }

        const labService =
            labServiceResult.recordset[0];

        const totalPrice = labService.price;

        const reference =
            `BK-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        // Default Status = Pending (1)
        const PENDING_STATUS_ID = 1;

        // -----------------------------------
        // Create Booking
        // -----------------------------------

        const bookingResult =
            await new sql.Request(transaction)
                .input('userId', sql.Int, userId)
                .input('ref', sql.VarChar(100), reference)
                .input('totalPrice', sql.Decimal(12, 6), totalPrice)
                .input('currentStatusId', sql.Int, PENDING_STATUS_ID)
                .input('createdBy', sql.NVarChar(255), userId.toString())
                .query(`
                    INSERT INTO bookings
                    (
                        userId,
                        ref,
                        totalPrice,
                        currentStatusId,
                        createdBy
                    )
                    OUTPUT INSERTED.*
                    VALUES
                    (
                        @userId,
                        @ref,
                        @totalPrice,
                        @currentStatusId,
                        @createdBy
                    )
                `);

        const booking =
            bookingResult.recordset[0];

        // -----------------------------------
        // Create Booking Service
        // -----------------------------------

        const bookingServiceResult =
            await new sql.Request(transaction)
                .input('bookingId', sql.Int, booking.id)
                .input('ref', sql.VarChar(100), reference)
                .input('serviceId', sql.Int, serviceId)
                .input('labId', sql.Int, labId)
                .input('total', sql.Decimal(12, 6), totalPrice)
                .input('serviceType', sql.VarChar(100), serviceType || 'Lab Visit')
                .input('isWalkIn', sql.Bit, isWalkIn || false)
                .input('date', sql.Date, date)
                .input('time', sql.VarChar(50), time)
                .input('homeAddress', sql.VarChar(sql.MAX), homeAddress || null)
                .input('addOns', sql.NVarChar(sql.MAX), addOnsValue)
                .input('createdBy', sql.NVarChar(255), userId.toString())
                .query(`
                    INSERT INTO booking_services
                    (
                        bookingId,
                        ref,
                        serviceId,
                        labId,
                        total,
                        serviceType,
                        isWalkIn,
                        date,
                        time,
                        homeAddress,
                        addOns,
                        createdBy
                    )
                    OUTPUT INSERTED.*
                    VALUES
                    (
                        @bookingId,
                        @ref,
                        @serviceId,
                        @labId,
                        @total,
                        @serviceType,
                        @isWalkIn,
                        @date,
                        @time,
                        @homeAddress,
                        @addOns,
                        @createdBy
                    )
                `);

        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: 'Booking created successfully',
            data: {
                booking: {
                    ...booking,
                    statusName: 'Pending'
                },
                bookingService:
                    bookingServiceResult.recordset[0]
            }
        });

    } catch (err) {

        if (transaction._aborted !== true) {
            await transaction.rollback();
        }

        console.error('Booking creation error:', err);

        return res.status(500).json({
            error: 'Failed to create booking'
        });
    }
});


module.exports = router;

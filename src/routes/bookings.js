const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken } = require('../middleware/auth');
const https = require('https')


const HOLD_MINUTES = 10;

function getPaystackSecretKey() {
    const secretKey = process.env.NODE_ENV === 'dev'
        ? process.env.PAYSTACK_SECRET_KEY_TEST
        : process.env.PAYSTACK_SECRET_KEY_LIVE;

    if (!secretKey) {
        const error = new Error('Payment verification is not configured.');
        error.status = 500;
        throw error;
    }

    return secretKey;
}

function verifyPaystackTransaction(reference) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.paystack.co',
            port: 443,
            path: `/transaction/verify/${encodeURIComponent(reference)}`,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${getPaystackSecretKey()}`,
            },
        };

        const paystackRequest = https.request(options, (paystackResponse) => {
            let responseBody = '';

            paystackResponse.on('data', (chunk) => {
                responseBody += chunk;
            });

            paystackResponse.on('end', () => {
                try {
                    const result = JSON.parse(responseBody);

                    if (paystackResponse.statusCode < 200 || paystackResponse.statusCode >= 300 || !result.status || !result.data) {
                        const error = new Error('Unable to verify payment with Paystack.');
                        error.status = 400;
                        return reject(error);
                    }

                    return resolve(result.data);
                } catch (error) {
                    error.message = 'Invalid response from payment provider.';
                    error.status = 502;
                    return reject(error);
                }
            });
        });

        paystackRequest.on('error', () => {
            const error = new Error('Unable to verify payment with Paystack.');
            error.status = 502;
            reject(error);
        });

        paystackRequest.end();
    });
}

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
       SELECT id, id as bookingId, userId, ref, labId, totalPrice as total, labAddOnCost, nonLabAddOnCost, status, isWalkIn, date, time, homeAddress, postCode, addOns, createdAt from bookings
       WHERE ${bookingId ? 'id = @id' : 'userId = @userId'} ORDER BY createdAt DESC
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
            SELECT b.id, ls.labId, b.labServiceId, s.name, b.price, ls.duration, s.category, s.description, ls.preparation, b.status
            FROM booking_services b 
            INNER JOIN bookings bk on b.bookingId = bk.id
            INNER JOIN lab_services ls on b.labServiceId = ls.serviceId AND bk.labId = ls.labId
            INNER JOIN lk_services s on s.id = ls.serviceId 
            WHERE b.bookingId = @bookingId
        `);

        booking.services = servicesResult.recordset;

        const testResult = await pool.request()
            .input('bookingId', sql.Int, booking.bookingId || null)
            .query(`SELECT * FROM test_results WHERE bookingId = @bookingId`);
        booking.testResult = testResult.recordset
    }

    return bookings;
}

// GET all bookings
router.get('/', verifyToken, async (req, res) => {
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
router.post('/id', verifyToken, async (req, res) => {
    const bookingId = req.body.bookingId;
    const userId = req.user?.userId;

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
router.get('/status/:status', verifyToken, async (req, res) => {
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
router.post('/hold', verifyToken, async (req, res) => {
    const { labId, slotDate, timeSlot } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!userId || !labId || !slotDate || !timeSlot) {
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

// POST reslease hold
router.post('/release-hold', verifyToken, async (req, res) => {
    const { labId, holdId } = req.body;
    if (!labId || !holdId) {
        return res.status(400).json({ error: 'labId, slotDate and timeSlot are required.' });
    }

    try {
        const result = await pool.request()
            .input('holdId', sql.Int, holdId)
            .input('labId', sql.Int, labId)
            .execute('usp_release_slot_hold');

        const row = result.recordset[0];

        switch (row.resultCode) {
            case 0:
                return res.status(200).json({
                    success: true,
                    message: `Slot hold cancelled`,
                });

            case 1:
                return res.status(409).json({ error: 'not active (already released)' });

            case 2:
                return res.status(404).json({ error: 'hold not found for this holdId' });

            default:
                return res.status(500).json({ error: 'Unexpected error reserving slot.' });
        }
    } catch (err) {
        return res.status(500).json({ error: 'Failed to release slot. Please try again.' });
    }
})


// POST confirm booking i.e convert held booking to full booking after payment
router.post('/confirm', verifyToken, async (req, res) => {
    const bookings = Array.isArray(req.body.data) ? req.body.data : [];
    const {
        subTotal,
        grandTotal,
        bookingFor,
        customerDetails,
        serviceFee,
        vat,
        gatewayProvider,
        gatewayReference,
    } = req.body;
    const userId = req.user?.userId

    if (!bookings.length) {
        return res.json([{
            status: 404,
            error: 'No bookings to confirm.'
        }]);
    }

    if (!userId) {
        return res.status(401).json([{
            status: 401,
            error: 'Unable to resolve authenticated user.'
        }]);
    }

    if (gatewayProvider !== 'paystack' || !gatewayReference) {
        return res.status(400).json([{
            status: 400,
            error: 'gatewayProvider must be paystack and gatewayReference is required.'
        }]);
    }

    const resultsArray = [];
    const lineItems = [];
    const firstBooking = bookings[0] || {};
    const bookingRef = firstBooking.ref ?? null;
    const paymentSubTotal = Number(subTotal);
    const paymentGrandTotal = Number(grandTotal);

    if (!Number.isFinite(paymentGrandTotal) || paymentGrandTotal <= 0) {
        return res.status(400).json([{
            status: 400,
            error: 'subTotal must be a positive number.'
        }]);
    }

    const fail = (status, error, labId = null) => {
        const err = new Error(error);
        err.status = status;
        err.labId = labId;
        throw err;
    };

    const transaction = new sql.Transaction(pool);
    let txBegun = false;

    try {
        const verifiedPayment = await verifyPaystackTransaction(gatewayReference);
        const expectedAmountInKobo = Math.round(paymentGrandTotal * 100);
        const paymentMetadata = verifiedPayment.metadata || {};

        if (
            verifiedPayment.status !== 'success' ||
            verifiedPayment.reference !== gatewayReference ||
            verifiedPayment.currency !== 'NGN' ||
            verifiedPayment.requested_amount !== expectedAmountInKobo ||
            String(paymentMetadata.userId) !== String(userId)
        ) {
            return res.status(400).json([{
                status: 400,
                error: 'Payment does not match this booking.'
            }]);
        }

        await transaction.begin();
        txBegun = true;

        // Process sequentially so all writes stay on a single transaction-bound connection.
        for (const b of bookings) {
            const labId = b.lab?.id;
            const services = b.services;
            const addOns = Array.isArray(b.addOns) ? b.addOns.join(', ') : null;
            const { holdId, ref, isWalkIn } = b;
            const homeAddress = b.homeAddress ?? null;
            const postCode = b.postCode ?? null;
            const totalPrice = b.total;
            const labServiceTotal = b.labServiceTotal;
            const labAddOnCost = b.labAddOnCost;
            const nonLabAddOnCost = b.nonLabAddOnCost;
            const labAddOnDetails = Array.isArray(b.labAddOnDetails) ? b.labAddOnDetails : [];

            if (!labId || !totalPrice || !Array.isArray(services) || services.length === 0) {
                fail(400, 'Missing required booking fields.', labId);
            }

            if (totalPrice <= 0) {
                fail(400, 'totalPrice must be non-negative.', labId);
            }

            const confirmResult = await new sql.Request(transaction)
                .input('holdId', sql.Int, holdId)
                .input('userId', sql.Int, userId)
                .input('ref', sql.NVarChar(50), ref ?? null)
                .input('walkInLabId', sql.Int, labId)
                .input('totalPrice', sql.Numeric(12, 2), labServiceTotal)
                .input('labAddOnCost', sql.Numeric(12, 2), labAddOnCost)
                .input('nonLabAddOnCost', sql.Numeric(12, 2), nonLabAddOnCost)
                .input('isWalkIn', sql.Bit, isWalkIn ? 1 : 0)
                .input('homeAddress', sql.NVarChar(sql.MAX), homeAddress)
                .input('postCode', sql.NVarChar(50), postCode)
                .input('addOns', sql.NVarChar(50), addOns)
                .input('createdBy', sql.NVarChar(255), String(userId))
                .input('services', sql.NVarChar(sql.MAX), JSON.stringify(services))
                .input('gatewayReference', sql.NVarChar(50), gatewayReference)
                .input('gatewayTransactionId', sql.NVarChar(255), String(verifiedPayment.id))
                .execute('usp_confirm_booking');

            const confirmRow = confirmResult.recordset?.[0];

            if (!confirmRow) {
                fail(500, 'Failed to confirm booking. Please try again.', labId);
            }

            if (confirmRow.resultCode === RESULT.SUCCESS) {
                lineItems.push({
                    bookingId: confirmRow.bookingId,
                    labId,
                    amount: labServiceTotal,
                    type: 'lab_subtotal',
                    description: `Booking fee for ${b.lab?.name || 'lab'}`,
                    addOnId: null
                });

                if (labAddOnDetails.length > 0) {
                    const labAddOnItems = labAddOnDetails.filter(j => j.isLabAddable === 1).map(x => ({
                        bookingId: confirmRow.bookingId,
                        labId,
                        amount: x.price,
                        type: 'lab_add_on',
                        description: `Add-On fee for ${b.lab?.name || 'lab'}`,
                        addOnId: x.id
                    }));
                    lineItems.push(...labAddOnItems);

                    const nonLabAddOnItems = labAddOnDetails.filter(j => j.isLabAddable === 0).map(x => ({
                        bookingId: confirmRow.bookingId,
                        labId,
                        amount: x.price,
                        type: 'non_lab_add_on',
                        description: `Add-On fee for ${b.lab?.name || 'lab'}`,
                        addOnId: x.id
                    }));
                    lineItems.push(...nonLabAddOnItems);
                }

                resultsArray.push({
                    status: 201,
                    bookingId: confirmRow.bookingId,
                    message: 'Booking confirmed successfully.',
                    labId
                });

                continue;
            }

            if (confirmRow.resultCode === RESULT.HOLD_EXPIRED_OR_INVALID && isWalkIn === false) {
                fail(410, 'Your slot reservation has expired or is invalid. Please select a new time slot.', labId);
            }

            if (confirmRow.resultCode === 2) {
                fail(409, 'Unable to confirm slot hold. Please retry.', labId);
            }

            if (confirmRow.resultCode === 5) {
                fail(410, 'This booking has already been processed.', labId);
            }

            fail(500, 'Failed to confirm booking. Please try again.', labId);
        }

        const paymentResult = await new sql.Request(transaction)
            .input('ref', sql.NVarChar(50), bookingRef)
            .input('userId', sql.Int, userId)
            .input('subTotal', sql.Numeric(12, 2), paymentSubTotal)
            .input('currency', sql.NVarChar(50), 'NGN')
            .input('gatewayStatus', sql.NVarChar(50), verifiedPayment.status)
            .input('gatewayProvider', sql.NVarChar(50), 'paystack')
            .input('gatewayTransactionId', sql.NVarChar(255), String(verifiedPayment.id))
            .input('gatewayReference', sql.NVarChar(255), gatewayReference)
            .input('serviceFee', sql.Numeric(12, 2), serviceFee)
            .input('VAT', sql.Numeric(12, 2), vat)
            .input('createdBy', sql.NVarChar(255), String(userId))
            .input('lineItems', sql.NVarChar(sql.MAX), JSON.stringify(lineItems))
            .execute('usp_record_payment');

        const paymentRow = paymentResult.recordset?.[0];
        if (!paymentRow || paymentRow.resultCode !== 0) {
            if (paymentRow?.resultCode === 6) {
                fail(400, 'Line items do not sum to the total charged.');
            }

            if (paymentRow?.resultCode === 7) {
                fail(400, 'One or more bookingIds are invalid.');
            }

            fail(500, 'Failed to record payment. Booking has been rolled back.');
        }

        if (bookingFor === 'someone') {
            if (!customerDetails?.fullName || !customerDetails?.email || !customerDetails?.phone) {
                fail(400, 'customerDetails.fullName, customerDetails.email and customerDetails.phone are required.');
            }

            await new sql.Request(transaction)
                .input('ref', sql.NVarChar(50), bookingRef)
                .input('fullName', sql.NVarChar(50), customerDetails.fullName)
                .input('email', sql.NVarChar(50), customerDetails.email)
                .input('phone', sql.NVarChar(50), customerDetails.phone)
                .input('birthYear', sql.NVarChar(50), customerDetails.yearOfBirth ?? null)
                .input('bookedBy', sql.NVarChar(255), String(userId))
                .query('INSERT INTO booking_users (ref, fullName, email, phone, birthYear, bookedBy, bookedAt) VALUES (@ref, @fullName, @email, @phone, @birthYear, @bookedBy, GETDATE())');
        }

        await transaction.commit();
        return res.json(resultsArray);
    } catch (err) {
        if (txBegun) {
            try {
                await transaction.rollback();
            } catch (rollbackErr) {
                console.error('[confirmBooking] rollback error:', rollbackErr);
            }
        }

        const status = err.status || 500;
        const error = err.message || 'Failed to confirm booking. Please try again.';
        const labId = err.labId ?? null;

        if (status === 500) {
            console.error('[confirmBooking] DB error:', err);
        }

        return res.status(status).json([{
            status,
            error,
            labId
        }]);
    }
})


// POST update booking date and time
router.put('/update-booking', verifyToken, async (req, res) => {

    const booking = req.body.data;
    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

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


router.post('/cancel-booking', verifyToken, async (req, res) => {
    const booking = req.body.data;
    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

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


// PUT update booking
router.put('/:id', verifyToken, async (req, res) => {
    const { ref, labId, date, time, status, total, addOns, isWalkIn, homeAddress, services } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        const request = new sql.Request(transaction);
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
            const deleteRequest = new sql.Request(transaction);
            deleteRequest.input('bookingId', sql.VarChar(50), req.params.id);
            await deleteRequest.query('DELETE FROM BookingServices WHERE bookingId = @bookingId');

            for (const serviceId of services) {
                const serviceRequest = new sql.Request(transaction);
                serviceRequest.input('bookingId', sql.VarChar(50), req.params.id);
                serviceRequest.input('serviceId', sql.VarChar(50), serviceId);
                await serviceRequest.query(`
          INSERT INTO BookingServices (bookingId, serviceId)
          VALUES (@bookingId, @serviceId)
        `);
            }
        }

        await transaction.commit();

        res.json({
            id: req.params.id, ref, labId, date, time, status, total, addOns, isWalkIn, homeAddress, services
        });
    } catch (err) {
        if (transaction._aborted !== true) {
            await transaction.rollback();
        }
        console.error('Error updating booking:', err);
        res.status(500).json({ error: 'Failed to update booking' });
    }
});

// DELETE booking
router.delete('/:id', verifyToken, async (req, res) => {
    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();
        const request = new sql.Request(transaction);
        request.input('id', sql.VarChar(50), req.params.id);

        // Delete booking services first
        const deleteServicesRequest = new sql.Request(transaction);
        deleteServicesRequest.input('bookingId', sql.VarChar(50), req.params.id);
        await deleteServicesRequest.query('DELETE FROM BookingServices WHERE bookingId = @bookingId');

        // Delete booking
        await request.query('DELETE FROM Bookings WHERE id = @id');

        await transaction.commit();

        res.json({ message: 'Booking deleted successfully' });
    } catch (err) {
        if (transaction._aborted !== true) {
            await transaction.rollback();
        }
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



// // GET user test results
router.get('/results/:userId', verifyToken, async (req, res) => {

    const userId = req.user?.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {

        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`SELECT a.userId, a.ref, a.labId, a.status, a.isWalkin, a.addOns, b.bookingId, b.fileUrl, b.testComments, b.createdBy, b.createdAt FROM bookings a INNER JOIN test_results b ON a.id = b.bookingId WHERE userId = @userId ORDER BY b.createdAt DESC;`)

        if (result.recordset.length === 0) {
            return [];
        }

        const results = result.recordset;

        for (const service of results) {
            const bookedServicesResult = await pool.request()
                .input('bookingId', sql.Int, service.bookingId)
                .query(`SELECT b.id, ls.labId, b.labServiceId, s.name, b.price, ls.duration, s.category, s.description, ls.preparation, b.status
                FROM booking_services b 
                INNER JOIN bookings bk on b.bookingId = bk.id
                INNER JOIN lab_services ls on b.labServiceId = ls.serviceId AND bk.labId = ls.labId
                INNER JOIN lk_services s on s.id = ls.serviceId 
                WHERE b.bookingId = @bookingId`);

            const bookedServices = bookedServicesResult.recordset
            service.services = bookedServices ?? []
        }


        return res.status(200).json({
            success: true,
            count: results.length,
            data: results
        });

    } catch (err) {

        console.error('Error fetching results:', err);

        return res.status(500).json({
            error: 'Failed to fetch results'
        });
    }
});


module.exports = router;

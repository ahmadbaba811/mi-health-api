const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { verifyToken, verifyAdmin } = require('../../middleware/auth');
const { Float } = require('mssql');


// dashboard statistics for admin, only admin can access this route
// GET /dashboard/stats
// Admin dashboard statistics
router.get('/stats', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;

    try {

        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`
                SELECT

                    -- Upcoming Bookings (Pending + Upcoming)
                    (
                        SELECT COUNT(*)
                        FROM bookings b
                        WHERE b.labId = @labId
                        AND b.status IN ('upcoming')
                    ) AS totalUpcomingBookings,

                    -- Completed Bookings
                    (
                        SELECT COUNT(*)
                        FROM bookings b
                        WHERE b.labId = @labId
                        AND b.status = 'completed'
                    ) AS totalCompletedBookings,

                    -- Total Revenue (Completed Bookings Only)
                    (
                        SELECT ISNULL(SUM(b.totalPrice), 0)
                        FROM bookings b
                        WHERE b.labId = @labId
                        AND b.status = 'completed'
                    ) AS totalRevenue,

                    -- Total Equipment
                    (
                        SELECT COUNT(*)
                        FROM equipment e
                        WHERE e.labId = @labId
                        AND e.isArchived = 0
                    ) AS totalEquipment
            `);

        const stats = result.recordset[0];

        return res.status(200).json({
            success: true,
            data: {
                totalUpcomingBookings:
                    Number(stats.totalUpcomingBookings || 0),

                totalCompletedBookings:
                    Number(stats.totalCompletedBookings || 0),

                totalRevenue:
                    Number(stats.totalRevenue || 0),

                totalEquipment:
                    Number(stats.totalEquipment || 0)
            }
        });

    } catch (err) {

        console.error('Dashboard stats error:', err);

        return res.status(500).json({
            error: 'Failed to retrieve dashboard statistics'
        });
    }
});

router.get('/service-categories', async (req, res) => {
    try {
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        const serviceRequest = new sql.Request(transaction);
        const serviceResult = await serviceRequest
            .query(`
                SELECT DISTINCT id, name, category, description FROM lk_services WHERE isActive = 1
            `);

        const services = serviceResult.recordset
        return res.status(200).json(services)

    } catch (error) {
        res.status(500).json({ message: 'error fetching services' })
    }
})


router.get('/services/:labId', verifyAdmin, async (req, res) => {
    const labId = req.params.labId
    try {
        const adminLabServices = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`SELECT s.id, s.name, ls.price, ls.duration, s.category, s.description, ls.preparation, ls.isActive
                        FROM lk_Services s
                        INNER JOIN lab_services ls ON s.id = ls.serviceId
                        WHERE ls.labId = @labId
                        ORDER BY s.createdAt DESC`);
        const labServices = adminLabServices.recordset
        return res.status(200).json(labServices)

    } catch (error) {
        res.status(500).json({ message: 'error fetching services' })
    }
})



// Add a new service, only admin can create a new service belonging to their lab 
router.post('/services', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const {
        serviceId,
        name,
        category,
        description,
        price,
        duration,
        preparation
    } = req.body;

    if (!name || !category || price <= 0) {
        return res.status(400).json({ error: 'name and category are required' });
    }

    try {
        const check = await pool.request()
            .input('serviceId', sql.Int, serviceId)
            .input('labId', sql.Int, labId)
            .query('SELECT id FROM lab_services WHERE serviceId = @serviceId AND labId = @labId');

        const checkResult = check.recordset
        if (checkResult.length > 0) {
            return res.json({
                success: false,
                message: 'exists'
            })
        }

        const labServiceResult = await pool.request()
            .input('labId', sql.Int, labId)
            .input('serviceId', sql.Int, serviceId)
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



        return res.status(201).json({
            success: true,
            data: {
                labService: labServiceResult.recordset[0]
            }
        });

    } catch (err) {

        console.error('Error creating service:', err);

        return res.status(500).json({
            error: 'Failed to create service'
        });
    }
});

router.patch('/services/update', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    const adminId = req.admin.adminId;
    const {
        serviceId,
        price,
        type
    } = req.body;

    try {
        if (type === 'statusChange') {
            const isActive = req.body.isActive
            const update = await pool.request()
                .input('serviceId', sql.Int, serviceId)
                .input('labId', sql.Int, labId)
                .input('isActive', sql.Bit, isActive)
                .query('UPDATE lab_services SET isActive = @isActive WHERE serviceId = @serviceId AND labId = @labId');
        } else {
            const update = await pool.request()
                .input('serviceId', sql.Int, serviceId)
                .input('labId', sql.Int, labId)
                .input('price', sql.Decimal(12, 6), price)
                .query('UPDATE lab_services SET price = @price WHERE serviceId = @serviceId AND labId = @labId');
        }

        return res.json({
            success: true,
            message: 'price updated'
        })
    } catch (err) {

        console.error('Error updating service:', err);

        return res.status(500).json({
            error: 'Failed to update service'
        });
    }
});


// // GET bookings Returns only bookings belonging to the admin's lab
router.get('/bookings', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;

    try {

        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`SELECT id, id as bookingId, userId, ref, labId, totalPrice as total, status, isWalkIn, date, time, homeAddress, postCode, addOns, createdAt from bookings WHERE labId = @labId ORDER BY createdAt DESC`)

        if (result.recordset.length === 0) {
            return [];
        }

        const bookings = result.recordset;

        for (const booking of bookings) {
            const bookedServicesResult = await pool.request()
                .input('bookingId', sql.Int, booking.bookingId)
                .query(`SELECT DISTINCT bs.id, bs.bookingId, bs.price, bs.status, s.name, bs.labServiceId, s.category FROM booking_services bs inner join lab_services ls on bs.labServiceId = ls.serviceId inner join lk_services s ON s.id = ls.serviceId WHERE bookingId = @bookingId`)

            const bookedServices = bookedServicesResult.recordset
            booking.services = bookedServices ?? []

            const userResult = await pool.request()
                .input('userId', sql.Int, booking.userId)
                .query(`SELECT id, email, firstName, lastName FROM users WHERE id = @userId`);
            booking.user = userResult.recordset
        }
        return res.status(200).json({
            success: true,
            count: bookings.length,
            data: bookings
        });

    } catch (err) {

        console.error('Error fetching bookings:', err);

        return res.status(500).json({
            error: 'Failed to fetch bookings'
        });
    }
});


// GET /dashboard/bookings/available-for-results
// Returns bookings that exist and do NOT yet have test results uploaded
router.get('/bookings/available-for-results', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;

    try {

        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`
                SELECT DISTINCT
                    b.id AS bookingId,
                    b.ref AS bookingCode,
                    bs.serviceType AS serviceName,
                    u.firstName + ' ' + u.lastName AS patientName
                FROM bookings b
                INNER JOIN booking_services bs
                    ON bs.bookingId = b.id
                INNER JOIN users u
                    ON b.userId = u.id
                WHERE bs.labId = @labId
                AND NOT EXISTS (
                    SELECT 1
                    FROM test_results tr
                    WHERE tr.bookingId = b.id
                )
                ORDER BY b.id DESC
            `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (err) {

        console.error('Error fetching available bookings for results:', err);

        return res.status(500).json({
            error: 'Failed to fetch available bookings'
        });
    }
});


// PATCH /dashboard/bookings/:id/status
// Updates the status of a booking (currentStatusId)
router.patch('/bookings/:id/status', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    const bookingId = parseInt(req.params.id, 10);
    const { ref, userId } = req.body.booking;
    const { status } = req.body

    // -----------------------------
    // VALIDATION
    // -----------------------------
    if (!status) {
        return res.status(400).json({
            error: 'status is required and must be Pending, Upcoming, Completed, or Cancelled'
        });
    }

    try {
        if (status === 'cancelled') {
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
                    return res.status(404).json({ message: row.reason, labId });

                default:
                    return res.status(500).json({ message: 'Unexpected error cancelling booking.' });
            }
        }

        // Verify booking exists and belongs to the admin's lab
        const bookingCheck = await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .input('labId', sql.Int, labId)
            .query(`
                SELECT bs.id
                FROM bookings bs
                WHERE bs.id = @bookingId
                AND bs.labId = @labId
            `);

        if (bookingCheck.recordset.length === 0) {
            return res.status(404).json({
                error: 'Booking not found'
            });
        }

        // Update the booking status and updatedAt timestamp
        await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .input('status', sql.VarChar(50), status)
            .input('ref', sql.VarChar(50), status)
            .query(`
                UPDATE bookings SET status = @status, updatedAt = GETDATE() WHERE id = @bookingId; 
                UPDATE booking_services SET status = @status, updatedAt = GETDATE() WHERE bookingId = @bookingId`
            );

        return res.status(200).json({
            success: true,
            message: 'Booking status updated successfully',
            data: status
        });

    } catch (err) {

        console.error('Error updating booking status:', err);

        return res.status(500).json({
            error: 'Failed to update booking status'
        });
    }
});


module.exports = router;

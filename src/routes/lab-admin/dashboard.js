const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { verifyToken, verifyAdmin  } = require('../../middleware/auth');


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
                        FROM booking_services bs
                        INNER JOIN bookings b
                            ON bs.bookingId = b.id
                        WHERE bs.labId = @labId
                        AND b.currentStatusId IN (1, 2)
                    ) AS totalUpcomingBookings,

                    -- Completed Bookings
                    (
                        SELECT COUNT(*)
                        FROM booking_services bs
                        INNER JOIN bookings b
                            ON bs.bookingId = b.id
                        WHERE bs.labId = @labId
                        AND b.currentStatusId = 3
                    ) AS totalCompletedBookings,

                    -- Total Revenue (Completed Bookings Only)
                    (
                        SELECT ISNULL(SUM(bs.total), 0)
                        FROM booking_services bs
                        INNER JOIN bookings b
                            ON bs.bookingId = b.id
                        WHERE bs.labId = @labId
                        AND b.currentStatusId = 3
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


// Add a new service, only admin can create a new service belonging to their lab 
router.post('/services', verifyAdmin, async (req, res) => {

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


// // GET bookings Returns only bookings belonging to the admin's lab
router.get('/bookings', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;

    try {

        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`
                SELECT
                    bs.id,
                    bs.bookingId,
                    bs.ref,
                    bs.serviceId,
                    bs.labId,

                    b.userId,
                    b.totalPrice,

                    bs.total,
                    bs.serviceType,
                    bs.isWalkIn,
                    bs.date,
                    bs.time,
                    bs.homeAddress,
                    bs.addOns,

                    b.currentStatusId,
                    s.name AS statusName,

                    bs.createdAt,
                    bs.updatedAt

                FROM booking_services bs

                INNER JOIN bookings b
                    ON bs.bookingId = b.id

                LEFT JOIN booking_statuses s
                    ON b.currentStatusId = s.id

                WHERE bs.labId = @labId

                ORDER BY bs.createdAt DESC
            `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
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
    const { statusId } = req.body;

    // -----------------------------
    // VALIDATION
    // -----------------------------
    if (!statusId || ![1, 2, 3, 4].includes(Number(statusId))) {
        return res.status(400).json({
            error: 'statusId is required and must be 1 (Pending), 2 (Upcoming), 3 (Completed), or 4 (Cancelled)'
        });
    }

    try {

        // Verify booking exists and belongs to the admin's lab
        const bookingCheck = await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .input('labId', sql.Int, labId)
            .query(`
                SELECT bs.id
                FROM booking_services bs
                WHERE bs.bookingId = @bookingId
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
            .input('currentStatusId', sql.Int, Number(statusId))
            .query(`
                UPDATE bookings
                SET currentStatusId = @currentStatusId,
                    updatedAt = GETDATE()
                WHERE id = @bookingId
            `);

        // Fetch the updated booking to return the new status name
        const updatedBooking = await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .query(`
                SELECT
                    b.id,
                    b.currentStatusId,
                    s.name AS statusName
                FROM bookings b
                LEFT JOIN booking_statuses s
                    ON b.currentStatusId = s.id
                WHERE b.id = @bookingId
            `);

        return res.status(200).json({
            success: true,
            message: 'Booking status updated successfully',
            data: updatedBooking.recordset[0]
        });

    } catch (err) {

        console.error('Error updating booking status:', err);

        return res.status(500).json({
            error: 'Failed to update booking status'
        });
    }
});


module.exports = router;

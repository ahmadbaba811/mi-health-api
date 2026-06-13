const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { verifyToken, verifyAdmin  } = require('../../middleware/auth');


// dashboard statistics for admin, only admin can access this route
router.get('/stats', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;

    try {

        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`
                SELECT

                    -- Upcoming (Pending + Upcoming)
                    SUM(
                        CASE 
                            WHEN b.currentStatusId IN (1, 2)
                            THEN 1 ELSE 0
                        END
                    ) AS totalUpcomingBookings,

                    -- Completed
                    SUM(
                        CASE 
                            WHEN b.currentStatusId = 3
                            THEN 1 ELSE 0
                        END
                    ) AS totalCompletedBookings,

                    -- Revenue (only completed bookings)
                    ISNULL(
                        SUM(
                            CASE 
                                WHEN b.currentStatusId = 3
                                THEN bs.total
                                ELSE 0
                            END
                        ), 0
                    ) AS totalRevenue

                FROM booking_services bs
                INNER JOIN bookings b
                    ON bs.bookingId = b.id
                WHERE bs.labId = @labId
            `);

        const stats = result.recordset[0];

        return res.status(200).json({
            success: true,
            data: {
                totalUpcomingBookings: stats.totalUpcomingBookings || 0,
                totalCompletedBookings: stats.totalCompletedBookings || 0,
                totalRevenue: Number(stats.totalRevenue || 0)
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



module.exports = router;
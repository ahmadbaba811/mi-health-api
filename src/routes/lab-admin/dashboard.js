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

                    -- Upcoming Bookings
                    SUM(
                        CASE
                            WHEN LOWER(LTRIM(RTRIM(status))) IN ('pending', 'upcoming', 'confirmed')
                            THEN 1
                            ELSE 0
                        END
                    ) AS totalUpcomingBookings,

                    -- Completed Bookings
                    SUM(
                        CASE
                            WHEN LOWER(LTRIM(RTRIM(status))) = 'completed'
                            THEN 1
                            ELSE 0
                        END
                    ) AS totalCompletedBookings,

                    -- Total Revenue
                    ISNULL(
                        SUM(
                            CASE
                                WHEN LOWER(LTRIM(RTRIM(status))) = 'completed'
                                THEN total
                                ELSE 0
                            END
                        ),
                        0
                    ) AS totalRevenue

                FROM booking_services
                WHERE labId = @labId
            `);

        const stats = result.recordset[0];

        return res.status(200).json({
            success: true,
            data: {
                totalUpcomingBookings:
                    stats.totalUpcomingBookings || 0,

                totalCompletedBookings:
                    stats.totalCompletedBookings || 0,

                totalRevenue:
                    Number(stats.totalRevenue || 0)
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

                    bs.total,
                    bs.status,
                    bs.serviceType,
                    bs.isWalkIn,
                    bs.date,
                    bs.time,
                    bs.homeAddress,
                    bs.addOns,

                   /* l.name AS labName, */

                    bs.createdAt,
                    bs.updatedAt

                FROM booking_services bs

                INNER JOIN bookings b
                    ON bs.bookingId = b.id

               /* INNER JOIN labs l
                    ON bs.labId = l.id */

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

router.post('/', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const {
        equipmentName,
        model,
        serialNumber,
        lastCalibrated,
        nextServiceDue,
        category,
        status,
        notes
    } = req.body;

    if (!equipmentName) {
        return res.status(400).json({
            error: 'equipmentName is required'
        });
    }

    if (!category) {
        return res.status(400).json({
            error: 'category is required'
        });
    }

    try {

        const transaction = new sql.Transaction(pool);

        await transaction.begin();

        const equipmentRequest = new sql.Request(transaction);

        const equipmentResult = await equipmentRequest
            .input('labId', sql.Int, labId)
            .input('equipmentName', sql.NVarChar(255), equipmentName)
            .input('model', sql.NVarChar(255), model || null)
            .input('equipmentType', sql.NVarChar(255), category)
            .input('serialNumber', sql.NVarChar(255), serialNumber || null)
            .input('lastCalibrated', sql.Date, lastCalibrated || null)
            .input('nextServiceDue', sql.Date, nextServiceDue || null)
            .input('status', sql.NVarChar(100), status || 'Operational')
            .input('notes', sql.NVarChar(sql.MAX), notes || null)
            .query(`
                INSERT INTO equipment
                (
                    labId,
                    equipmentName,
                    model,
                    equipmentType,
                    serialNumber,
                    lastCalibrated,
                    nextServiceDue,
                    currentStatus,
                    notes,
                    isActive,
                    isArchived,
                    createdAt
                )
                OUTPUT INSERTED.*
                VALUES
                (
                    @labId,
                    @equipmentName,
                    @model,
                    @equipmentType,
                    @serialNumber,
                    @lastCalibrated,
                    @nextServiceDue,
                    @status,
                    @notes,
                    1,
                    0,
                    SYSUTCDATETIME()
                )
            `);

        const equipment = equipmentResult.recordset[0];

        await new sql.Request(transaction)
            .input('equipmentId', sql.Int, equipment.id)
            .input('newStatusId', sql.NVarChar(100), status || 'Operational')
            .input('reason', sql.NVarChar(500), 'Equipment created')
            .input('changedBy', sql.Int, adminId)
            .query(`
                INSERT INTO equipment_status_log
                (
                    equipmentId,
                    previousStatusId,
                    newStatusId,
                    reason,
                    changed_by,
                    changed_at
                )
                VALUES
                (
                    @equipmentId,
                    NULL,
                    @newStatusId,
                    @reason,
                    @changedBy,
                    SYSUTCDATETIME()
                )
            `);

        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: 'Equipment created successfully',
            data: equipment
        });

    } catch (err) {

        console.error('Equipment creation error:', err);

        return res.status(500).json({
            error: 'Failed to create equipment'
        });
    }
});

module.exports = router;
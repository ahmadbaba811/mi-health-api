const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyAdmin  } = require('../middleware/auth');


// get equipment
router.get('/', verifyAdmin, async (req, res) => {
    const labId = req.admin.labId;

    try {
        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`
                SELECT 
                    e.id,
                    e.equipmentName AS equipment,
                    e.equipmentType AS category,
                    e.model,
                    e.serialNumber,
                    e.lastCalibrated,
                    e.nextServiceDue,
                    e.notes,
                    e.currentStatusId
                FROM equipment e
                WHERE e.labId = @labId
                  AND e.isArchived = 0
                ORDER BY e.createdAt DESC
            `);

        const mapped = result.recordset.map(e => ({
            id: e.id,
            equipment: e.equipment,
            category: e.category,
            modelSerial: `${e.model || ''} / ${e.serialNumber || ''}`,
            calibrated: e.lastCalibrated,
            nextService: e.nextServiceDue,
            notes: e.notes,
            statusId: e.currentStatusId
        }));

        return res.status(200).json({
            success: true,
            data: mapped
        });

    } catch (err) {
        console.error('Equipment fetch error:', err);
        return res.status(500).json({
            error: 'Failed to fetch equipment'
        });
    }
});

// Add a new equipment, only a verified lab admin can add equipment 
router.post('/add-equipment', verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const {
        equipmentName,
        model,
        serialNumber,
        lastCalibrated,
        nextServiceDue,
        category,
        statusId,
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

        // Validate status exists
        const statusCheck = await new sql.Request(transaction)
            .input('statusId', sql.TinyInt, statusId || 1)
            .query(`
                SELECT id
                FROM equipment_statuses
                WHERE id = @statusId
            `);

        if (statusCheck.recordset.length === 0) {
            await transaction.rollback();

            return res.status(400).json({
                error: 'Invalid statusId'
            });
        }

        // Create equipment
        const equipmentResult = await new sql.Request(transaction)
            .input('labId', sql.Int, labId)
            .input('equipmentName', sql.NVarChar(255), equipmentName)
            .input('model', sql.NVarChar(255), model || null)
            .input('equipmentType', sql.NVarChar(255), category)
            .input('serialNumber', sql.NVarChar(255), serialNumber || null)
            .input('lastCalibrated', sql.Date, lastCalibrated || null)
            .input('nextServiceDue', sql.Date, nextServiceDue || null)
            .input('currentStatusId', sql.TinyInt, statusId || 1)
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
                    currentStatusId,
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
                    @currentStatusId,
                    @notes,
                    1,
                    0,
                    SYSUTCDATETIME()
                )
            `);

        const equipment = equipmentResult.recordset[0];

        // Create status history record
        await new sql.Request(transaction)
            .input('equipmentId', sql.Int, equipment.id)
            .input('newStatusId', sql.TinyInt, statusId || 1)
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


// PUT update an equipment equipment
router.put('/:id', verifyAdmin, async (req, res) => {

    const equipmentId = parseInt(req.params.id);

    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const {
        equipmentName,
        model,
        serialNumber,
        lastCalibrated,
        nextServiceDue,
        category,
        statusId,
        notes,
        isActive,
        isArchived
    } = req.body;

    if (!equipmentId) {
        return res.status(400).json({
            error: 'Invalid equipment id'
        });
    }

    const transaction = new sql.Transaction(pool);

    try {

        await transaction.begin();

        // Verify ownership
        const equipmentResult = await new sql.Request(transaction)
            .input('equipmentId', sql.Int, equipmentId)
            .input('labId', sql.Int, labId)
            .query(`
                SELECT *
                FROM equipment
                WHERE id = @equipmentId
                AND labId = @labId
            `);

        if (equipmentResult.recordset.length === 0) {

            await transaction.rollback();

            return res.status(404).json({
                error: 'Equipment not found'
            });
        }

        const existingEquipment = equipmentResult.recordset[0];

        // Validate status exists
        if (statusId) {

            const statusCheck = await new sql.Request(transaction)
                .input('statusId', sql.TinyInt, statusId)
                .query(`
                    SELECT id
                    FROM equipment_statuses
                    WHERE id = @statusId
                `);

            if (statusCheck.recordset.length === 0) {

                await transaction.rollback();

                return res.status(400).json({
                    error: 'Invalid statusId'
                });
            }
        }

        // Update equipment
        const updateResult = await new sql.Request(transaction)
            .input('equipmentId', sql.Int, equipmentId)
            .input('equipmentName', sql.NVarChar(255), equipmentName)
            .input('model', sql.NVarChar(255), model)
            .input('serialNumber', sql.NVarChar(255), serialNumber)
            .input('lastCalibrated', sql.Date, lastCalibrated || null)
            .input('nextServiceDue', sql.Date, nextServiceDue || null)
            .input('equipmentType', sql.NVarChar(255), category)
            .input('currentStatusId', sql.TinyInt, statusId)
            .input('notes', sql.NVarChar(sql.MAX), notes)
            .input('isActive', sql.Bit, isActive)
            .input('isArchived', sql.Bit, isArchived)
            .query(`
                UPDATE equipment
                SET
                    equipmentName = @equipmentName,
                    model = @model,
                    serialNumber = @serialNumber,
                    lastCalibrated = @lastCalibrated,
                    nextServiceDue = @nextServiceDue,
                    equipmentType = @equipmentType,
                    currentStatusId = @currentStatusId,
                    notes = @notes,
                    isActive = @isActive,
                    isArchived = @isArchived
                OUTPUT INSERTED.*
                WHERE id = @equipmentId
            `);

        const updatedEquipment = updateResult.recordset[0];

        // Log status change only if status changed
        if (
            statusId &&
            existingEquipment.currentStatusId !== statusId
        ) {

            await new sql.Request(transaction)
                .input('equipmentId', sql.Int, equipmentId)
                .input('previousStatusId', sql.TinyInt, existingEquipment.currentStatusId)
                .input('newStatusId', sql.TinyInt, statusId)
                .input('reason', sql.NVarChar(500), 'Status updated')
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
                        @previousStatusId,
                        @newStatusId,
                        @reason,
                        @changedBy,
                        SYSUTCDATETIME()
                    )
                `);
        }

        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: 'Equipment updated successfully',
            data: updatedEquipment
        });

    } catch (err) {

        await transaction.rollback();

        console.error('Equipment update error:', err);

        return res.status(500).json({
            error: 'Failed to update equipment'
        });
    }
});

router.delete('/:id', verifyAdmin, async (req, res) => {
    const labId = req.admin.labId;
    const equipmentId = req.params.id;

    try {
        // 1. Verify ownership
        const check = await pool.request()
            .input('id', sql.Int, equipmentId)
            .input('labId', sql.Int, labId)
            .query(`
                SELECT id 
                FROM equipment 
                WHERE id = @id AND labId = @labId
            `);

        if (check.recordset.length === 0) {
            return res.status(404).json({
                error: 'Equipment not found or access denied'
            });
        }

        // 2. Soft delete (archive instead of deleting)
        await pool.request()
            .input('id', sql.Int, equipmentId)
            .query(`
                UPDATE equipment
                SET isArchived = 1
                WHERE id = @id
            `);

        return res.status(200).json({
            success: true,
            message: 'Equipment deleted successfully'
        });

    } catch (err) {
        console.error('Equipment delete error:', err);
        return res.status(500).json({
            error: 'Failed to delete equipment'
        });
    }
});


module.exports = router;

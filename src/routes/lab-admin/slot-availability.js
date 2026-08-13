const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { verifyToken, verifyAdmin } = require('../../middleware/auth');

const parseLabId = (value) => {
    const labId = Number(value)
    return Number.isInteger(labId) && labId > 0 ? labId : null
}

const parseCapacity = (value) => {
    const capacity = Number(value)
    return Number.isInteger(capacity) && capacity > 0 ? capacity : null
}

const normalizeSlot = (slot) => {
    if (!slot || typeof slot !== "object") return null

    const date = String(slot.date || "").trim()
    const time = String(slot.time || "").trim()
    const capacity = parseCapacity(slot.capacity)
    const isAvailable = slot.isAvailable === undefined ? true : Boolean(slot.isAvailable)
    const reservedCount = Number.isInteger(Number(slot.reservedCount)) ? Number(slot.reservedCount) : 0

    if (!date || !time) return null

    return {
        date,
        time,
        isAvailable,
        capacity: capacity ?? 1,
        reservedCount: Math.max(0, reservedCount),
    }
}

router.get("/", verifyAdmin, async (req, res) => {

    const labId = req.admin.labId;
    if (!labId) {
        return res.status(400).json({ message: "Invalid lab id" })
    }

    try {
        const result = await pool
            .request()
            .input("labId", sql.Int, labId)
            .query(`SELECT id, labId, slotDate AS date, timeSlot AS time, isAvailable, capacity, reservedCount FROM time_slot_availability WHERE labId = @labId AND capacity > 0 AND slotDate >= CAST(GETDATE() AS DATE) ORDER BY slotDate, timeSlot
      `)

        res.json(result.recordset.map((slot) => ({
            id: slot.id,
            labId: slot.labId,
            date: slot.date,
            time: slot.time,
            isAvailable: slot.isAvailable === 1 || slot.isAvailable === true,
            capacity: slot.capacity,
            reservedCount: slot.reservedCount ?? 0,
        })))
    } catch (error) {
        res.status(500).json({ message: "Failed to load availability slots", error: error.message })
    }
})

router.post("/", verifyAdmin, async (req, res) => {
    const labId = req.admin.labId
    if (!labId) {
        return res.status(400).json({ message: "Invalid lab id" })
    }

    const incomingSlots = Array.isArray(req.body?.slots) ? req.body.slots : []
    const normalizedSlots = incomingSlots.map(normalizeSlot).filter(Boolean)

    try {
        const transaction = new sql.Transaction(pool)
        await transaction.begin()

        try {
            const createdBy = String(req.body?.createdBy || "system").trim();

            const request = transaction.request()
                .input("labId", sql.Int, labId)
                .input("createdBy", sql.NVarChar(150), createdBy)
                .input("slots", sql.NVarChar(sql.MAX), JSON.stringify(normalizedSlots));

            const result = await request.query(`
        ;WITH Slots AS (
            SELECT DISTINCT
                @labId AS labId,
                slotDate,
                timeSlot,
                isAvailable,
                capacity,
                reservedCount
            FROM OPENJSON(@slots)
            WITH (
                slotDate      DATE        '$.date',
                timeSlot      NVARCHAR(8) '$.time',
                isAvailable   BIT         '$.isAvailable',
                capacity      INT         '$.capacity',
                reservedCount INT         '$.reservedCount'
            )
        )
        INSERT INTO [dbo].[time_slot_availability] (
            [labId],
            [slotDate],
            [timeSlot],
            [isAvailable],
            [capacity],
            [reservedCount],
            [createdAt],
            [createdBy],
            [updatedAt]
        )
        OUTPUT INSERTED.labId
        SELECT
            s.labId,
            s.slotDate,
            s.timeSlot,
            s.isAvailable,
            s.capacity,
            s.reservedCount,
            SYSUTCDATETIME(),
            @createdBy,
            SYSUTCDATETIME()
        FROM Slots s
        WHERE NOT EXISTS (
            SELECT 1
            FROM [dbo].[time_slot_availability] t
            WHERE t.labId = s.labId
              AND t.slotDate = s.slotDate
              AND t.timeSlot = s.timeSlot
        );
    `);

            await transaction.commit();

            res.status(201).json({
                success: true,
                labId,
                slotsSaved: result.recordset.length,
                slotsReceived: normalizedSlots.length
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        res.status(500).json({ message: "Failed to save availability slots", error: error.message })
    }
})

router.put("/update/:id", verifyAdmin, async (req, res) => {
    const labId = req.admin.labId
    const id = req.params.id
    const type = req.body.type
    if (!labId) {
        return res.status(400).json({ message: "Invalid lab id" })
    }
    if (!id) {
        return res.status(400).json({
            message: "Invalid availability id"
        });
    }
    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        const request = transaction.request()
            .input("labId", sql.Int, labId)
            .input("id", sql.Int, id);
        let result;

        if (type === 'add') {
            result = await request.query(`
            UPDATE time_slot_availability WITH (UPDLOCK)
            SET 
                capacity = capacity + 1,
                updatedAt = SYSUTCDATETIME()
            WHERE id = @id
              AND labId = @labId
        `);
        } else {
            result = await request.query(`
            UPDATE time_slot_availability WITH (UPDLOCK)
            SET 
                capacity = capacity - 1,
                updatedAt = SYSUTCDATETIME()
            WHERE id = @id
              AND labId = @labId
              AND capacity > 0;
        `);
        }

        if (result.rowsAffected[0] === 0) {
            await transaction.rollback();

            return res.status(409).json({
                success: false,
                message: "No available capacity for this slot."
            });
        }

        await transaction.commit();

        return res.status(200).json({
            success: true
        });

    } catch (error) {
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error("Rollback failed:", rollbackError);
        }
        return res.status(500).json({
            success: false,
            message: "Failed to update availability",
            error: error.message
        });
    }
})














module.exports = router;
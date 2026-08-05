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

router.get("/:labId", async (req, res) => {
  const labId = parseLabId(req.params.labId)
  if (!labId) {
    return res.status(400).json({ message: "Invalid lab id" })
  }

  try {
    const result = await pool
      .request()
      .input("labId", sql.Int, labId)
      .query(`
        SELECT
          [slotDate] AS [date],
          [timeSlot] AS [time],
          [isAvailable],
          [capacity],
          [reservedCount]
        FROM [dbo].[time_slot_availability]
        WHERE [labId] = @labId
        ORDER BY [slotDate], [timeSlot];
      `)

    res.json(result.recordset.map((slot) => ({
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

router.post("/:labId", async (req, res) => {
  const labId = parseLabId(req.params.labId)
  if (!labId) {
    return res.status(400).json({ message: "Invalid lab id" })
  }

  const incomingSlots = Array.isArray(req.body?.slots) ? req.body.slots : []
  const normalizedSlots = incomingSlots.map(normalizeSlot).filter(Boolean)

  try {
    const transaction = new sql.Transaction(pool)
    await transaction.begin()

    try {
      await transaction.request()
        .input("labId", sql.Int, labId)
        .query(`
          DELETE FROM [dbo].[time_slot_availability]
          WHERE [labId] = @labId;
        `)

      for (const slot of normalizedSlots) {
        await transaction.request()
          .input("labId", sql.Int, labId)
          .input("slotDate", sql.Date, slot.date)
          .input("timeSlot", sql.NVarChar(8), slot.time)
          .input("isAvailable", sql.Bit, slot.isAvailable)
          .input("capacity", sql.Int, slot.capacity)
          .input("reservedCount", sql.Int, slot.reservedCount)
          .input("createdBy", sql.NVarChar(150), String(req.body?.createdBy || "system").trim())
          .query(`
            INSERT INTO [dbo].[time_slot_availability] (
              [labId], [slotDate], [timeSlot], [isAvailable], [capacity], [reservedCount], [createdAt], [createdBy], [updatedAt]
            )
            VALUES (
              @labId, @slotDate, @timeSlot, @isAvailable, @capacity, @reservedCount, SYSUTCDATETIME(), @createdBy, SYSUTCDATETIME()
            );
          `)
      }

      await transaction.commit()
      res.status(201).json({ success: true, labId, slotsSaved: normalizedSlots.length })
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } catch (error) {
    res.status(500).json({ message: "Failed to save availability slots", error: error.message })
  }
})














module.exports = router;
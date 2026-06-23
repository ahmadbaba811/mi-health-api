const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, sql } = require('../../db');
const { verifyToken, verifyAdmin  } = require('../../middleware/auth');

// Add a test result for a specific booking 
router.post('/', verifyAdmin, async (req, res) => {
    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const {
        bookingId,
        testName,
        overallStatusId,
        patientName,
        patientEmail,
        clinicalSummary,
        biomarkers, // array
        files // optional
    } = req.body;

    // -----------------------------
    // VALIDATION
    // -----------------------------
    if (!bookingId || !testName || !overallStatusId || !clinicalSummary) {
        return res.status(400).json({
            error: 'bookingId, testName, overallStatusId, and clinicalSummary are required'
        });
    }

    if (!Array.isArray(biomarkers) || biomarkers.length === 0) {
        return res.status(400).json({
            error: 'At least one biomarker is required'
        });
    }

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        // -----------------------------
        // 1. VERIFY BOOKING EXISTS AND BELONGS TO LAB
        // -----------------------------
        const bookingCheck = await new sql.Request(transaction)
            .input('bookingId', sql.Int, bookingId)
            .input('labId', sql.Int, labId)
            .query(`
                SELECT bs.id
                FROM booking_services bs
                WHERE bs.bookingId = @bookingId
                AND bs.labId = @labId
            `);

        if (bookingCheck.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({
                error: 'Booking not found'
            });
        }

        // -----------------------------
        // 2. CHECK IF RESULTS ALREADY UPLOADED FOR THIS BOOKING
        // -----------------------------
        const existingResultCheck = await new sql.Request(transaction)
            .input('bookingId', sql.Int, bookingId)
            .query(`
                SELECT 1
                FROM test_results tr
                WHERE tr.bookingId = @bookingId
            `);

        if (existingResultCheck.recordset.length > 0) {
            await transaction.rollback();
            return res.status(409).json({
                error: 'Results already uploaded for this booking'
            });
        }

        // -----------------------------
        // 3. CREATE TEST RESULT HEADER
        // -----------------------------
        const testResultRequest = new sql.Request(transaction);

        const testResult = await testResultRequest
            .input('bookingId', sql.Int, bookingId)
            .input('labId', sql.Int, labId)
            .input('testName', sql.NVarChar(255), testName)
            .input('overallStatusId', sql.Int, overallStatusId)
            .input('patientName', sql.NVarChar(255), patientName || null)
            .input('patientEmail', sql.NVarChar(255), patientEmail || null)
            .input('clinicalSummary', sql.NVarChar(sql.MAX), clinicalSummary)
            .input('createdBy', sql.NVarChar(255), adminId.toString())
            .query(`
                INSERT INTO test_results
                (
                    bookingId,
                    labId,
                    testName,
                    overallStatusId,
                    patientName,
                    patientEmail,
                    clinicalSummary,
                    createdBy
                )
                OUTPUT INSERTED.id
                VALUES
                (
                    @bookingId,
                    @labId,
                    @testName,
                    @overallStatusId,
                    @patientName,
                    @patientEmail,
                    @clinicalSummary,
                    @createdBy
                )
            `);

        const testResultId = testResult.recordset[0].id;

        // -----------------------------
        // 3. INSERT BIOMARKERS (BATCH)
        // -----------------------------
        for (const item of biomarkers) {
            if (!item.name || !item.value || !item.statusId) {
                await transaction.rollback();
                return res.status(400).json({
                    error: 'Each biomarker must include name, value, and statusId'
                });
            }

            await new sql.Request(transaction)
                .input('testResultId', sql.Int, testResultId)
                .input('biomarkerName', sql.NVarChar(255), item.name)
                .input('value', sql.NVarChar(100), item.value)
                .input('unit', sql.NVarChar(50), item.unit || null)
                .input('referenceRange', sql.NVarChar(100), item.referenceRange || null)
                .input('statusId', sql.Int, item.statusId)
                .query(`
                    INSERT INTO test_result_biomarkers
                    (
                        testResultId,
                        biomarkerName,
                        value,
                        unit,
                        referenceRange,
                        statusId
                    )
                    VALUES
                    (
                        @testResultId,
                        @biomarkerName,
                        @value,
                        @unit,
                        @referenceRange,
                        @statusId
                    )
                `);
        }

        // -----------------------------
        // 4. OPTIONAL FILES (PLACEHOLDER)
        // -----------------------------
        

        if (files && files.length > 0) {
            for (const file of files) {
                await new sql.Request(transaction)
                    .input('testResultId', sql.Int, testResultId)
                    .input('fileUrl', sql.NVarChar(500), file.url)
                    .input('fileType', sql.NVarChar(50), file.type || null)
                    .query(`
                        INSERT INTO test_result_files
                        (
                            testResultId,
                            fileUrl,
                            fileType
                        )
                        VALUES
                        (
                            @testResultId,
                            @fileUrl,
                            @fileType
                        )
                    `);
            }
        }

        // -----------------------------
        // 5. COMMIT TRANSACTION
        // -----------------------------
        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: 'Test result uploaded successfully',
            data: {
                testResultId
            }
        });

    } catch (err) {
        await transaction.rollback();

        console.error('Test result upload error:', err);

        return res.status(500).json({
            error: 'Failed to upload test result'
        });
    }
});


// get all test results 
router.get('/', verifyAdmin, async (req, res) => {
    const labId = req.admin.labId;

    try {
        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .query(`
                SELECT 
                    tr.id AS testResultId,
                    tr.bookingId,
                    tr.testName,
                    tr.patientName,
                    tr.patientEmail,
                    tr.clinicalSummary,
                    tr.createdAt,

                    ts.name AS overallStatus,

                    b.id AS biomarkerId,
                    b.biomarkerName,
                    b.value,
                    b.unit,
                    b.referenceRange,

                    bs.name AS biomarkerStatus

                FROM test_results tr

                INNER JOIN lk_test_statuses ts
                    ON tr.overallStatusId = ts.id

                LEFT JOIN test_result_biomarkers b
                    ON tr.id = b.testResultId

                LEFT JOIN lk_biomarker_statuses bs
                    ON b.statusId = bs.id

                WHERE tr.labId = @labId

                ORDER BY tr.createdAt DESC
            `);

        // -----------------------------
        // GROUP ROWS (flatten → nested)
        // -----------------------------
        const map = new Map();

        for (const row of result.recordset) {

            if (!map.has(row.testResultId)) {
                map.set(row.testResultId, {
                    testResultId: row.testResultId,
                    bookingId: row.bookingId,
                    testName: row.testName,
                    patientName: row.patientName,
                    patientEmail: row.patientEmail,
                    clinicalSummary: row.clinicalSummary,
                    createdAt: row.createdAt,
                    overallStatus: row.overallStatus,
                    biomarkers: []
                });
            }

            if (row.biomarkerId) {
                map.get(row.testResultId).biomarkers.push({
                    id: row.biomarkerId,
                    name: row.biomarkerName,
                    value: row.value,
                    unit: row.unit,
                    referenceRange: row.referenceRange,
                    status: row.biomarkerStatus
                });
            }
        }

        return res.status(200).json({
            success: true,
            count: map.size,
            data: Array.from(map.values())
        });

    } catch (err) {
        console.error('Error fetching test results:', err);

        return res.status(500).json({
            error: 'Failed to fetch test results'
        });
    }
});

module.exports = router;
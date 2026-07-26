const express = require('express');
const router = express.Router();
const { pool, sql } = require('../../db');
const { verifyAdmin, verifyToken } = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const { MAX } = require('mssql');

// Add a test result document for a specific booking 
router.post('/', verifyAdmin, upload.single('document'), async (req, res) => {
    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const { bookingId } = req.body;
    const file = req.file;
    
    if (!bookingId) {
        return res.status(400).json({ error: 'bookingId is required' });
    }

    if (!file) {
        return res.status(400).json({ error: 'document file is required (.pdf or .docx)' });
    }

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        // 1. VERIFY BOOKING EXISTS AND BELONGS TO LAB
        const bookingCheck = await new sql.Request(transaction)
            .input('bookingId', sql.Int, bookingId)
            .input('labId', sql.Int, labId)
            .query(`
                SELECT bs.id
                FROM bookings bs
                WHERE bs.id = @bookingId
                AND bs.labId = @labId
            `);

        if (bookingCheck.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ error: 'Booking not found or does not belong to your lab' });
        }

        // 2. CHECK IF RESULTS ALREADY UPLOADED FOR THIS BOOKING
       const existingResultCheck = await new sql.Request(transaction)
            .input('bookingId', sql.Int, bookingId)
            .query(`
                SELECT 1
                FROM test_results
                WHERE bookingId = @bookingId
            `);

        if (existingResultCheck.recordset.length > 0) {
            await transaction.rollback();
            return res.status(409).json({ error: 'Results already uploaded for this booking' });
        }

        // 3. INSERT THE FILE RECORD INTO THE NEW SIMPLIFIED test_results TABLE
        const fileUrl = file.location || `/uploads/${file.filename}`; // Handles both S3 and local

        const testResult = await new sql.Request(transaction)
            .input('bookingId', sql.Int, bookingId)
            .input('labId', sql.Int, labId)
            .input('fileUrl', sql.NVarChar(500), fileUrl)
            .input('fileType', sql.NVarChar(100), file.mimetype)
            .input('fileSizeBytes', sql.Int, file.size)
            .input('createdBy', sql.NVarChar(255), adminId.toString())
            .query(`
                INSERT INTO test_results
                (
                    bookingId,
                    labId,
                    fileUrl,
                    fileType,
                    fileSizeBytes,
                    createdBy
                )
                OUTPUT INSERTED.id
                VALUES
                (
                    @bookingId,
                    @labId,
                    @fileUrl,
                    @fileType,
                    @fileSizeBytes,
                    @createdBy
                )
            `);

        const testResultId = testResult.recordset[0].id;

        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: 'Test result document uploaded successfully',
            data: {
                testResultId,
                fileUrl,
                bookingId
            }
        });

    } catch (err) {
        if (transaction._aborted !== true) {
            await transaction.rollback();
        }
        console.error('Test result upload error:', err);
        return res.status(500).json({ error: 'Failed to upload test result document' });
    }
});

// get all test results 
router.get('/:id', verifyAdmin, async (req, res) => {
    const labId = req.admin.labId;
    const bookingId = req.params.id

    try {
        const result = await pool.request()
            .input('labId', sql.Int, labId)
            .input('bookingId', sql.Int, bookingId)
            .query(`
                SELECT 
                    id AS testResultId,
                    bookingId,
                    fileUrl,
                    fileType,
                    createdAt,
                    testComments,
                    commentsBy
                FROM test_results
                WHERE labId = @labId AND bookingId = @bookingId
                ORDER BY createdAt DESC
            `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (err) {
        console.error('Error fetching test results:', err);
        return res.status(500).json({ error: 'Failed to fetch test results' });
    }
});


// Add result commentry
router.patch('/update', verifyAdmin, async (req, res) => {
    const labId = req.admin.labId;
    const adminId = req.admin.adminId;

    const { bookingId, comment } = req.body;
    try {

        if (!comment) {
            return res.status(409).json({ error: 'Comment cannot be empty' });
        }

        const testResultComment = await pool.request()
            .input('bookingId', sql.Int, bookingId)
            .input('commentsBy', sql.Int, adminId)
            .input('testComments', sql.VarChar(MAX), comment)
            .query(`UPDATE test_results SET testComments = @testComments, commentsBy = @commentsBy, commentsDate = GETDATE() WHERE bookingId = @bookingId `);

        return res.status(201).json({
            success: true,
            message: 'Test result comment added successfully'
        });

    } catch (err) {
        console.log(err)
        console.error('Test result upload error:', err);
        return res.status(500).json({ error: 'Failed to upload test result document' });
    }
});






module.exports = router;
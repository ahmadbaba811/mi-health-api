const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { verifyToken } = require('../middleware/auth');
const https = require('https')

// Initialize payment
router.post("/initialize", async (req, res) => {
    try {
        const params = JSON.stringify({
            email: req.body.email,
            amount: req.body.amount * 100, // ₦5,000.00 in kobo
        });

        const options = {
            hostname: "api.paystack.co",
            port: 443,
            path: "/transaction/initialize",
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.NODE_ENV === "dev" ?
                    process.env.PAYSTACK_SECRET_KEY_TEST : process.env.PAYSTACK_SECRET_KEY_LIVE}`,
                "Content-Type": "application/json",
            },
        };

        const paystackReq = https.request(options, (paystackRes) => {
            let data = "";

            paystackRes.on("data", (chunk) => {
                data += chunk;
            });

            paystackRes.on("end", () => {
                try {
                    const result = JSON.parse(data);
                    return res.status(paystackRes.statusCode).json(result);
                } catch (err) {
                    return res.status(500).json({
                        success: false,
                        message: "Invalid response from Paystack",
                    });
                }
            });
        });

        paystackReq.on("error", (error) => {
            console.error(error);

            return res.status(500).json({
                success: false,
                message: "Failed to initialize payment",
            });
        });

        paystackReq.write(params);
        paystackReq.end();
    } catch (error) {
        console.log(error)
        return res.status(500).json({
            success: false,
            message: "Failed to initialize payment",
        });
    }
});


module.exports = router;
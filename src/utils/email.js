const nodemailer = require('nodemailer');
require("dotenv").config();

function isEmailConfigured() {
    return Boolean(
        process.env.SMTP_HOST &&
        process.env.SMTP_PORT &&
        process.env.SMTP_USER &&
        process.env.SMTP_PASS &&
        process.env.EMAIL_FROM
    );
}

function createTransport() {
    if (!isEmailConfigured()) {
        throw new Error('Email service is not configured. Set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, and EMAIL_FROM in your environment.');
    }

    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    })
}

async function sendEmail({ to, subject, html, bcc }) {
    if (!to || !subject) {
        throw new Error('Missing required email fields: to, subject are required.');
    }

    const transporter = createTransport();

    const mailOptions = {
        from: process.env.EMAIL_FROM,
        to,
        subject,
        html,
        bcc
        // attachments: [
        //     {
        //         filename: 'document.pdf',           // Name the file will have in the email
        //         path: path.join(__dirname, 'document.pdf') // Local file path on your machine
        //     }
        // ]
    }

    await transporter.sendMail(mailOptions);
}

module.exports = { sendEmail };

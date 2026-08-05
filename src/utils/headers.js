const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

function configureSecurity(app) {
  const isProduction = process.env.NODE_ENV !== "dev";

  const allowedOrigins = isProduction
    ? [
        "https://mihealth.ng",
        "https://www.mihealth.ng",
        "https://admin.mihealth.ng", // Remove if not used
      ]
    : [
        "http://localhost:5173",
        "http://localhost:3000",
      ];

  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginResourcePolicy: {
        policy: isProduction ? "same-site" : "cross-origin",
      },
      crossOriginOpenerPolicy: {
        policy: "same-origin",
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
    })
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Allow Postman, curl and server-to-server requests
        if (!origin) {
          return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
      ],
    })
  );

  app.use(express.json());
  app.set('trust proxy', 1);
}

module.exports = configureSecurity;
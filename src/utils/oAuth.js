const { sql, pool } = require("../db");
const { OAuth2Client } = require("google-auth-library")
const jwt = require('jsonwebtoken');
const { generatePassword } = require("./helpers");
const bcrypt = require('bcrypt');



async function isEmailRegistered(email) {
    try {
        const request = pool.request();
        request.input('email', sql.VarChar(255), email);

        const result = await request.query(`
      SELECT COUNT(1) AS existingCount
      FROM Users
      WHERE email = @email
    `);

        return result.recordset[0].existingCount > 0;
    } catch (err) {
        console.error('Error checking email existence:', err);
        return false;
    }
}


async function mapUserRow(row) {
    if (!row) return null
    return {
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        birthYear: row.birthYear,
        photoUrl: row.photoUrl,
        phone: row.phone
    }
}

async function findUserByEmail(email) {
    const result = await pool.request()
        .input("email", sql.VarChar(255), email)
        .query(`
      SELECT id, email, phone, isActive, firstName, lastName, emailVerified, birthYear, photoUrl, 'existing' AS userType
      FROM Users
      WHERE email = @email
    `)

    return result.recordset[0] || null
}

async function createOAuthUser({ email, firstName, lastName, photoUrl }) {

    const passwordHash = await bcrypt.hash(generatePassword(8), 10);
    const result = await pool.request()
        .input("email", sql.VarChar(255), email)
        .input("firstName", sql.VarChar(255), firstName || "")
        .input("lastName", sql.VarChar(255), lastName || "")
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .input("accountType", sql.VarChar(50), 'personal')
        .query(`
      INSERT INTO Users (email, firstName, lastName, passwordHash, isActive, emailVerified, accountType, providerName)
      OUTPUT INSERTED.id, INSERTED.email, INSERTED.isActive, INSERTED.phone, INSERTED.firstName, INSERTED.lastName, INSERTED.emailVerified, INSERTED.birthYear, INSERTED.photoUrl, 'new' AS userType
      VALUES (@email, @firstName, @lastName, @passwordHash, 1, 'verified', @accountType, 'google')
    `)

    return result.recordset[0]
}

async function markEmailVerified(userId) {
    await pool.request()
        .input("id", sql.Int, userId)
        .query("UPDATE Users SET emailVerified = 'verified' WHERE id = @id AND emailVerified IS NULL")
}

/**
 * Finds the user by email (creating one if this is their first OAuth sign-in) and returns
 * the same raw row shape the password login route reads from the database.
 */
async function findOrCreateOAuthUser({ email, firstName, lastName, photoUrl }) {
    const existing = await findUserByEmail(email)
    if (existing) {
        if (existing.emailVerified === null) {
            await markEmailVerified(existing.id)
            existing.emailVerified = "verified"
        }
        return existing
    }

    return createOAuthUser({ email, firstName, lastName, photoUrl })
}


async function signAppToken(user) {
    const token = jwt.sign(
        {
            userId: user.id,
            email: user.email
        },
        process.env.JWT_SECRET || 'your-secret-key',
        {
            expiresIn: '24h',
            issuer: 'mi-health-api',
            audience: 'mi-health-client'
        }
    );
    return token;
}

function verifyAppToken(token) {
    return jwt.verify(token, JWT_SECRET, {
        issuer: 'mi-health-api',
        audience: 'mi-health-client'
    })
}

async function logSuccessfulLogin(userId, email) {
    try {
        const request = pool.request();
        request.input('userId', sql.Int, userId);
        request.input('email', sql.VarChar(255), email);
        request.input('timestamp', sql.DateTime, new Date());

        await request.query(`
      INSERT INTO login_attempts (userId, success, timestamp, email)
      VALUES (@userId, 1, @timestamp, @email)
    `);
    } catch (err) {
        console.error('Error logging successful login:', err);
    }
}

async function completeOAuthSignIn(res, profile) {

    const user = await findOrCreateOAuthUser(profile)

    if (!user.isActive) {
        return res.status(403).json({
            error: 'inactive',
            message: 'Account is inactive. Please contact support.'
        })
    }

    const token = await signAppToken(user)
    await logSuccessfulLogin(user.id, user.email);

    res.status(200).json({
        success: true,
        message: 'Login successful',
        token,
        user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            birthYear: user.birthYear,
            photoUrl: user.photoUrl,
            phone: user.phone,
            userType: user.userType
        }
    })
}




const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const client = new OAuth2Client(GOOGLE_CLIENT_ID)


async function verifyGoogleIdToken(idToken) {
    if (!GOOGLE_CLIENT_ID) {
        throw new Error("GOOGLE_CLIENT_ID is not configured on the server")
    }

    const ticket = await client.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID
    })

    const payload = ticket.getPayload()
    if (!payload?.email) {
        throw new Error("Google token did not include an email address")
    }

    return {
        email: payload.email,
        firstName: payload.given_name || "",
        lastName: payload.family_name || "",
        providerId: payload.sub,
        photoUrl: payload.picture
    }
}



async function verifyMicrosoftIdToken(idToken) {
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID
    const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || "common"


    const jwks = createRemoteJWKSet(
        new URL(`https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/discovery/v2.0/keys`)
    )


    if (!MICROSOFT_CLIENT_ID) {
        throw new Error("MICROSOFT_CLIENT_ID is not configured on the server")
    }

    const { payload } = await jwtVerify(idToken, jwks, {
        audience: MICROSOFT_CLIENT_ID
    })

    const issuerIsValid = /^https:\/\/login\.microsoftonline\.com\/.+\/v2\.0$/.test(payload.iss || "")
    if (!issuerIsValid) {
        throw new Error("Microsoft token has an unexpected issuer")
    }

    const email = payload.email || payload.preferred_username
    if (!email) {
        throw new Error("Microsoft token did not include an email address")
    }

    return {
        email,
        firstName: payload.given_name || "",
        lastName: payload.family_name || "",
        providerId: payload.oid || payload.sub
    }
}



module.exports = { findOrCreateOAuthUser, completeOAuthSignIn, isEmailRegistered, verifyGoogleIdToken, logSuccessfulLogin, signAppToken, verifyMicrosoftIdToken }
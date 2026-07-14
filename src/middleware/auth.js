const jwt = require('jsonwebtoken');

// Middleware to verify JWT token
function verifyToken(req, res, next) {
  // const authHeader = req.headers['authorization'];

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: 'Access Token required'
    });
  }

  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      error: 'Access token required'
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key',
      {
        issuer: 'mi-health-api',
        audience: 'mi-health-client'
      }
    );

    // Attach user info to request
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token has expired'
      });
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(403).json({
        error: 'Invalid token'
      });
    }

    res.status(403).json({
      error: 'Token verification failed'
    });
  }
}


// Admin JWT Middleware to protect lab-admin-only endpoints

function verifyAdmin(req, res, next) {

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: 'Token required'
    });
  }

  const token = authHeader.split(' ')[1];

  try {

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET,
      {
        issuer: 'mi-health-api',
        audience: 'mi-health-admin'
      }
    );

    if (decoded.role !== 'LabAdmin') {
      return res.status(403).json({
        error: 'Admin access required'
      });
    }

    req.admin = decoded;

    next();

  } catch {
    return res.status(401).json({
      error: 'Invalid token'
    });
  }
}


module.exports = {
  verifyToken,
  verifyAdmin
};

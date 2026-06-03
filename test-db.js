require('dotenv').config();
const sql = require('mssql');

const cfg = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  pool: { max: 5, min: 0 },
  options: {
    encrypt: process.env.DB_ENCRYPT ? process.env.DB_ENCRYPT === 'true' : false,
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',
  },
};

(async () => {
  console.log('Testing DB connection with config:', {
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    encrypt: cfg.options. encrypt,
    trustServerCertificate: cfg.options.trustServerCertificate,
  });

  try {
    const pool = await sql.connect(cfg);
    console.log('OK: connected to SQL Server');
    await pool.close();
  } catch (err) {
    console.error('Connect error:', err.message || err);
    if (err.code) console.error('Error code:', err.code);
    if (err.originalError) console.error('Original:', err.originalError.message || err.originalError);
  } finally {
    process.exit();
  }
})();

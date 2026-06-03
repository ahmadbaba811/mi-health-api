const sql = require('mssql');

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  // port: parseInt(process.env.DB_PORT),
  pool: {
    max: 20,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  options: {
    encrypt: false,
    enableArithAbort: true,
  },
};

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect(config)
  .then(() => {
    console.log('Connected to SQL Server');
  })
  .catch((err) => {
    console.error('SQL Server connection error:', err);
    throw err;
  });

module.exports = { sql, pool, poolConnect };

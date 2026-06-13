const { poolConnect, sql } = require('./src/db');

async function test() {
  await poolConnect;
  const result = await sql.query(`
    SELECT status, COUNT(*) as count 
    FROM booking_services 
    GROUP BY status
  `);
  console.log('Stats from booking_services:', result.recordset);
  process.exit(0);
}
test();

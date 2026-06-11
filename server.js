require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { pool, poolConnect, sql } = require('./src/db');

const usersRouter = require('./src/routes/users');
const authRouter = require('./src/routes/auth');
const addOnsRouter = require('./src/routes/add-ons');
const servicesRouter = require('./src/routes/services');
const labsRouter = require('./src/routes/labs');
const timeSlotsRouter = require('./src/routes/time-slots');
const bookingsRouter = require('./src/routes/bookings');
const equipmentRouter = require('./src/routes/equipment');
const adminAuthRouter = require('./src/routes/admin-auth');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV });
});

app.use('/users', usersRouter);
app.use('/auth', authRouter);
app.use('/admin-auth', adminAuthRouter);
app.use('/add-ons', addOnsRouter);
app.use('/services', servicesRouter);
app.use('/labs', labsRouter);
app.use('/time-slots', timeSlotsRouter);
app.use('/bookings', bookingsRouter);
app.use('/equipment', equipmentRouter);

const port = parseInt(process.env.PORT, 10);

// Ensure DB connection is attempted before starting
poolConnect
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to DB, server will not start.', err);
    process.exit(1);
  });

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { pool, poolConnect, sql } = require('./src/db');
const configureSecurity  = require('./src/utils/headers')

const usersRouter = require('./src/routes/users');
const authRouter = require('./src/routes/auth');
const addOnsRouter = require('./src/routes/add-ons');
const servicesRouter = require('./src/routes/services');
const labsRouter = require('./src/routes/labs');
const timeSlotsRouter = require('./src/routes/time-slots');
const bookingsRouter = require('./src/routes/bookings');
const equipmentRouter = require('./src/routes/equipment');
const adminAuthRouter = require('./src/routes/lab-admin/admin-auth');
const adminDashboardRouter = require('./src/routes/lab-admin/dashboard');
const testResultRouter = require('./src/routes/lab-admin/test-result');
const superAdminRouter = require('./src/routes/super-admin/super-admin')
const paymentRouter = require('./src/routes/payment')
const slotAvailabilityRouter = require('./src/routes/lab-admin/slot-availability')



const app = express();
const { sendMail, isEmailConfigured } = require('./src/utils/email');

// app.use(helmet());
// app.use(cors());
// app.use(express.json());

configureSecurity(app);


app.get('/', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV });
});

// Serve uploaded files statically
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/users', usersRouter);
app.use('/auth', authRouter);
app.use('/admin-auth', adminAuthRouter);
app.use('/dashboard', adminDashboardRouter);
app.use('/admin/admin', superAdminRouter);
app.use('/slots', slotAvailabilityRouter);
app.use('/add-ons', addOnsRouter);
app.use('/services', servicesRouter);
app.use('/labs', labsRouter);
app.use('/time-slots', timeSlotsRouter);
app.use('/bookings', bookingsRouter);
app.use('/equipment', equipmentRouter);
app.use('/test-result', testResultRouter);
app.use('/payment', paymentRouter);


const port = parseInt(process.env.PORT, 10)|| 5000 ;

// Ensure DB connection is attempted before starting
poolConnect
  .then(() => {
    console.log("Database connected successfully");

    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("DB connection failed:", err);
    process.exit(1);
  });

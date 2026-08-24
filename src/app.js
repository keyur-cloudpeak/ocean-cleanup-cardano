import express from 'express';
import cors from 'cors';
import activityRoutes from './routes/activityRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import authRoutes from './routes/authRoutes.js';
import organizationRoutes from './routes/organizationRoutes.js';
import contributorRoutes from './routes/contributorRoutes.js';
import citizenRoutes from './routes/citizenRoutes.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'ocean-cleanup-backend' });
});
app.use('/api/activities', activityRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin/organizations', organizationRoutes);
app.use('/api/contributor', contributorRoutes);
app.use('/api/citizen', citizenRoutes);
app.use(errorHandler);

export default app;

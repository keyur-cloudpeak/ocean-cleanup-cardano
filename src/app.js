import express from 'express';
import cors from 'cors';
import activityRoutes from './routes/activityRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import authRoutes from './routes/authRoutes.js';
import organizationRoutes from './routes/organizationRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import adminReportRoutes from './routes/adminReportRoutes.js';
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
app.use('/api/events', eventRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin/organizations', organizationRoutes);
app.use('/api/admin/admins', adminRoutes);
app.use('/api/admin/reports', adminReportRoutes);
app.use('/api/contributor', contributorRoutes);
app.use('/api/citizen', citizenRoutes);
app.use(errorHandler);

export default app;

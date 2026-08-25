import { Router } from 'express';
import adminReportController from '../controllers/adminReportController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticate, authorizeRoles('admin'));

router.get('/contributors/:userId', adminReportController.getContributorReport);
router.get('/contributors/:userId/export', adminReportController.exportContributorReport);
router.get('/citizens/:userId', adminReportController.getCitizenReport);

export default router;

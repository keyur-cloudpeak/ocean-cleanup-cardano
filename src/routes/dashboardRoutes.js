import { Router } from 'express';
import dashboardController from '../controllers/dashboardController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/stats', dashboardController.getStats);
router.get('/users', dashboardController.getUserLists);
router.patch('/users/:id/active', dashboardController.setUserActiveStatus);
router.get('/organizations', dashboardController.getPublicOrganizations);
router.get('/notifications', authenticate, authorizeRoles('admin'), dashboardController.getNotifications);
router.patch('/notifications/:id/read', authenticate, authorizeRoles('admin'), dashboardController.markNotificationRead);

export default router;

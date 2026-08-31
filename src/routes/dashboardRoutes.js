import { Router } from 'express';
import dashboardController from '../controllers/dashboardController.js';
import { authenticate, authorizeRoles, attachUserIfPresent } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/stats', dashboardController.getStats);
router.get('/users', authenticate, authorizeRoles('admin'), dashboardController.getUserLists);
router.patch('/users/:id/active', authenticate, authorizeRoles('admin'), dashboardController.setUserActiveStatus);
router.get('/organizations', dashboardController.getPublicOrganizations);
// Stays reachable without a token (signup creates orgs before the user has
// one), but a token IS decoded when sent, so a signed-in contributor who
// creates an org from the submit form gets enrolled in it (spec §19).
router.post('/organizations', attachUserIfPresent, dashboardController.createPublicOrganization);
// Any authenticated role — each caller only ever sees their own role's
// broadcasts plus notifications targeted at their own user id (enforced in
// the controller/service layer, not here), so this no longer needs to be
// admin-only the way it was when notifications were admin-broadcast-only.
router.get('/notifications', authenticate, dashboardController.getNotifications);
router.patch('/notifications/:id/read', authenticate, dashboardController.markNotificationRead);

export default router;

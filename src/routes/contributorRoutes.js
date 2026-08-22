import { Router } from 'express';
import contributorController from '../controllers/contributorController.js';
import { authenticate, authorizeRoles, requireAuthenticatedUser } from '../middleware/authMiddleware.js';

const router = Router();

// GET /api/contributor/stats — authenticated contributor (or admin) only
router.get('/stats', authenticate, authorizeRoles('contributor', 'admin'), requireAuthenticatedUser, contributorController.getStats);

// GET /api/contributor/insights — locations, disposal, and wildlife breakdowns
router.get('/insights', authenticate, authorizeRoles('contributor', 'admin'), requireAuthenticatedUser, contributorController.getInsights);

// GET /api/contributor/export — PDF field report of the contributor's approved activities
router.get('/export', authenticate, authorizeRoles('contributor', 'admin'), requireAuthenticatedUser, contributorController.exportReport);

export default router;

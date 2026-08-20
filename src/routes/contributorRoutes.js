import { Router } from 'express';
import contributorController from '../controllers/contributorController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

// GET /api/contributor/stats — authenticated contributor (or admin) only
router.get('/stats', authenticate, authorizeRoles('contributor', 'admin'), contributorController.getStats);

// GET /api/contributor/insights — locations, disposal, and wildlife breakdowns
router.get('/insights', authenticate, authorizeRoles('contributor', 'admin'), contributorController.getInsights);

export default router;

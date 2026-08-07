import { Router } from 'express';
import contributorController from '../controllers/contributorController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

// GET /api/contributor/stats — authenticated contributor (or admin) only
router.get('/stats', authenticate, authorizeRoles('contributor', 'admin'), contributorController.getStats);

export default router;

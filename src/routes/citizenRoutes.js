import { Router } from 'express';
import citizenController from '../controllers/citizenController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

// GET /api/citizen/stats — requires citizen or admin auth
router.get('/stats', authenticate, authorizeRoles('citizen', 'admin'), citizenController.getStats);

// GET /api/citizen/leaderboard — requires auth (any role can view)
router.get('/leaderboard', authenticate, citizenController.getLeaderboard);

// GET /api/citizen/feed — public endpoint, optional auth
router.get('/feed', citizenController.getFeed);

export default router;

import { Router } from 'express';
import contributorInviteController from '../controllers/contributorInviteController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticate, authorizeRoles('admin'));

// POST /api/admin/contributors – invite a new contributor by email
router.post('/', contributorInviteController.invite);

export default router;

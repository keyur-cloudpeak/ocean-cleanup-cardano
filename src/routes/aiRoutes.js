import { Router } from 'express';
import aiController from '../controllers/aiController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

// POST /api/ai/infer — draft an event classification from a photo or text.
// Citizen/contributor only: this is intake-time assistance, not something
// admins/verifiers need to call directly.
router.post('/infer', authenticate, authorizeRoles('citizen', 'contributor'), aiController.infer);
router.post('/chat', authenticate, authorizeRoles('citizen', 'contributor'), aiController.chat);

export default router;

import { Router } from 'express';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';
import { analyze } from '../controllers/aiAnalysisController.js';

const router = Router();
router.post('/analyze-image', authenticate, authorizeRoles('citizen', 'contributor'), analyze);

export default router;
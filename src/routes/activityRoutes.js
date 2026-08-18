import { Router } from 'express';
import multer from 'multer';
import activityController from '../controllers/activityController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();
// Store uploaded file in memory as a Buffer (no disk writes)
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', activityController.list);
router.post('/', authenticate, authorizeRoles('citizen', 'contributor'), upload.array('images', 10), activityController.create);
router.get('/:id', activityController.getById);
router.get('/:id/proof', activityController.proof);
router.post('/:id/review', authenticate, authorizeRoles('admin', 'verifier'), activityController.review);
router.patch('/:id', authenticate, upload.array('images', 10), activityController.update);
router.delete('/:id', authenticate, activityController.remove);

export default router;

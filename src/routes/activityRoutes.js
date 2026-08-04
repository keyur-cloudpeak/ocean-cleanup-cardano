import { Router } from 'express';
import multer from 'multer';
import activityController from '../controllers/activityController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();
// Store uploaded file in memory as a Buffer (no disk writes)
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', activityController.list);
router.post('/', upload.single('image'), activityController.create);
router.get('/:id', activityController.getById);
router.post('/:id/review', authenticate, authorizeRoles('admin', 'verifier'), activityController.review);
router.post('/:id/mint', authenticate, authorizeRoles('admin', 'verifier'), activityController.mint);
router.patch('/:id', authenticate, upload.single('image'), activityController.update);
router.delete('/:id', authenticate, activityController.remove);

export default router;

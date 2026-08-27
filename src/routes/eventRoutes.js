import { Router } from 'express';
import multer from 'multer';
import eventController from '../controllers/eventController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Read-only for now, same as activityRoutes' list/getById — unauthenticated
// on purpose, matching the existing public-read convention for activities.
// /subjects must be registered before /:id or Express would treat
// "subjects" as an :id value.
router.get('/subjects', eventController.getSubjects);
router.get('/', eventController.list);
router.get('/:id', eventController.getById);

// Plan/complete an action — an organizational act, not a raw evidence
// submission, so it's gated the same way activity review is: contributor
// (acting on behalf of an org), verifier, or admin.
router.post('/:id/actions', authenticate, authorizeRoles('contributor', 'verifier', 'admin'), eventController.planAction);
router.post('/:id/complete', authenticate, authorizeRoles('contributor', 'verifier', 'admin'), upload.array('images', 10), eventController.complete);

// Verify — deliberately excludes 'contributor'. This is the actual gate
// spec §20/§27 describe: the person who submitted or completed the work
// must not be the one who confirms it, so only a verifier or admin can
// call this regardless of who is logged in.
router.post('/:id/verify', authenticate, authorizeRoles('verifier', 'admin'), eventController.verify);

// Generic typed relationship creation (duplicate_of, disputes, follow_up_to,
// etc.) — same audience as plan/complete above.
router.post('/:id/relate', authenticate, authorizeRoles('contributor', 'verifier', 'admin'), eventController.relate);

export default router;

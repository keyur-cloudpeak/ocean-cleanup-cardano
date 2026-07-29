import { Router } from 'express';
import organizationController from '../controllers/organizationController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

// All organization management routes are restricted to admin role
router.use(authenticate, authorizeRoles('admin'));

// GET    /api/admin/organizations          – list all (optional ?active=true|false)
router.get('/',    organizationController.list);

// GET    /api/admin/organizations/:id      – get single org
router.get('/:id', organizationController.getById);

// POST   /api/admin/organizations          – create org
router.post('/',   organizationController.create);

// PUT    /api/admin/organizations/:id      – full / partial update
router.put('/:id', organizationController.update);

// DELETE /api/admin/organizations/:id      – hard delete
router.delete('/:id', organizationController.remove);

// PATCH  /api/admin/organizations/:id/status – toggle active flag
router.patch('/:id/status', organizationController.setStatus);

export default router;

import { Router } from 'express';
import adminController from '../controllers/adminController.js';
import { authenticate, authorizeRoles } from '../middleware/authMiddleware.js';

const router = Router();

// All admin management routes are restricted to admin role
router.use(authenticate, authorizeRoles('admin'));

// GET    /api/admin/admins       – list all admins
router.get('/', adminController.list);

// POST   /api/admin/admins       – invite a new admin by email
router.post('/', adminController.invite);

// DELETE /api/admin/admins/:id   – remove an admin
router.delete('/:id', adminController.remove);

export default router;

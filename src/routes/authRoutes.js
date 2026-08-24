import { Router } from 'express';
import authController from '../controllers/authController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/signup', authController.signup);
router.get('/email-availability', authController.checkEmailAvailability);
router.post('/login', authController.login);
router.post('/admin/login', authController.adminLogin);
router.post('/forgot-password', authController.requestPasswordReset);
router.get('/reset-password', authController.renderPasswordResetPage);
router.post('/reset-password', authController.completePasswordReset);
router.get('/validate-invite', authController.validateInviteToken);
router.post('/set-password', authController.setPassword);
router.post('/logout', authController.logout);
router.get('/verify', authController.verify);
router.get('/verify-email', authController.verifyEmail);
router.put('/profile', authenticate, authController.updateProfile);
router.put('/admin/profile', authenticate, authController.updateAdminProfile);

export default router;

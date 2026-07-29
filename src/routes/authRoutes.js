import { Router } from 'express';
import authController from '../controllers/authController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/verify', authController.verify);
router.post('/wallet', authenticate, authController.updateWallet);

export default router;

import { Router } from 'express';
import uploadController from '../controllers/uploadController.js';

const router = Router();

router.post('/', uploadController.upload);

export default router;

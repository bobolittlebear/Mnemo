import authController from '../controllers/auth.controller';
import { Router } from 'express';

const router: Router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);

export default router;

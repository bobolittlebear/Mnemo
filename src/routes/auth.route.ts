import Express from 'express';
import authController from '../controllers/auth.controller';

const router = Express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);

export default router;

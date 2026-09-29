import authController from '../controllers/auth.controller';
import { authMiddleware } from '@/middleware/auth.middleware';
import { Router } from 'express';

const router: Router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
// 取当前登录用户：复用 authMiddleware 校验 cookie，未登录返回 401（信封）。
// 仅用于前端“已登录则跳过登录/注册页”的探测，故挂在 /auth 下、且需鉴权。
router.get('/me', authMiddleware, authController.me);

export default router;

import { Router } from 'express';
import { handleStreamChat } from '../controllers/chat.controller';
// import { authMiddleware } from '../middleware/auth.middleware'; // 如果需要鉴权

const router: Router = Router();

// POST /api/chat
// 建议加上鉴权中间件，防止接口被盗刷
router.post('/chat', handleStreamChat);

export default router;

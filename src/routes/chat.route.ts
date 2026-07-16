import { Router } from 'express';
import {
    chat,
    endSession,
    getChatHistory,
    clearChatHistory,
} from '@/controllers/chat.controller';
// import { authMiddleware } from '../middleware/auth.middleware'; // 如果需要鉴权
import { memoryMiddleware } from '@/middleware/memory.middleware';
import { traceMiddleware } from '@/middleware/trace.middleware';
import { createVector } from '@/controllers/embedding.controller';
import { extractFacts, ingestFacts } from '@/controllers/memory.controller';
const router: Router = Router();
// 建议加上鉴权中间件，防止接口被盗刷
// router.use(authMiddleware); // 保护所有后续路由，必须先通过认证
router.use(memoryMiddleware); // 开启会话时加上短期记忆key
// POST /api/chat

// 仅为 /chat 路由挂载 traceMiddleware
// 执行顺序：memoryMiddleware -> traceMiddleware -> chat Controller
router.post('/chat', traceMiddleware, chat);

router.post('/session/end', endSession);
router.get('/chat/history', getChatHistory);
router.delete('/chat/history', clearChatHistory);
router.put('/embedding', createVector);
router.put('/fact/extract', extractFacts);
router.put('/fact/pipeline', ingestFacts);

export default router;

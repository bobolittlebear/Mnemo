import { Router } from 'express';
import {
    chat,
    handleToolResult,
    endSession,
    getChatHistory,
    clearChatHistory,
} from '@/controllers/chat.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { memoryMiddleware } from '@/middleware/memory.middleware';
import { traceMiddleware } from '@/middleware/trace.middleware';
import { createVector } from '@/controllers/embedding.controller';
import { extractFacts, ingestFacts } from '@/controllers/memory.controller';

const router: Router = Router();

router.use(authMiddleware);
router.use(memoryMiddleware); // 开启会话时加上短期记忆key

router.post('/chat', traceMiddleware, chat);
// 工具执行回执 → 内联续轮（只服务写模式；上下文域由已挂载的 memoryMiddleware 注入）
router.post('/chat/tool-result', traceMiddleware, handleToolResult);

router.post('/session/end', endSession);
router.get('/chat/history', getChatHistory);
router.delete('/chat/history', clearChatHistory);
router.put('/embedding', createVector);
router.put('/fact/extract', extractFacts);
router.put('/fact/pipeline', ingestFacts);

export default router;

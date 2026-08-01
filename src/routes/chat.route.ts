import { Router } from 'express';
import {
    chat,
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

router.post('/session/end', endSession);
router.get('/chat/history', getChatHistory);
router.delete('/chat/history', clearChatHistory);
router.put('/embedding', createVector);
router.put('/fact/extract', extractFacts);
router.put('/fact/pipeline', ingestFacts);

export default router;

// src/middleware/memory.middleware.ts
/**
 * 短期记忆key中间件，在调用大模型api之前，根据用户ID生成，或生成临时会话key
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// 扩展Express的Request类型，添加userId属性
declare global {
    namespace Express {
        interface Request {
            meta: {
                sessionId?: string;
            };
        }
    }
}

export const memoryMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    let sessionId: string = req.body?.session_id || req.query?.session_id;

    req.meta = { sessionId };

    next();
};

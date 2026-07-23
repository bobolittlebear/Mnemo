// src/middleware/memory.middleware.ts
/**
 * 短期记忆key中间件，在调用大模型api之前，根据用户ID生成，或生成临时会话key
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { COOKIE_MEMORY_KEY_MAX_AGE } from '@/utils/constant';

// 扩展Express的Request类型，添加userId属性
declare global {
    namespace Express {
        interface Request {
            user: {
                userId?: string;
                // 可选的 sessionId，可用于短期记忆键或设备区分
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
    let sessionId: string =
        req.cookies?.session_id ?? crypto.randomBytes(16).toString('hex');

    res.cookie('session_id', sessionId, {
        httpOnly: true,
        // secure: true, // 仅在 HTTPS 下传输（本地测试如果是 HTTP 请改为 false）
        sameSite: 'strict',
        maxAge: COOKIE_MEMORY_KEY_MAX_AGE,
    });
    req.user = { ...req.user, sessionId };

    next();
};

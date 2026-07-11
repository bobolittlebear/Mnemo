// src/middleware/memory.middleware.ts
/**
 * 短期记忆key中间件，在调用大模型api之前，根据用户ID生成，或生成临时会话key
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { generateMemoryKey } from '@/utils/tool';
import { COOKIE_MEMORY_KEY_MAX_AGE, SESSION_KEY_PREFIX } from '@/utils/constant';

// 扩展Express的Request类型，添加userId属性
declare global {
    namespace Express {
        interface Request {
            user: {
                userId?: string;
                // 可选的 sessionId，可用于短期记忆键或设备区分
                memoryKey?: string;
            };
        }
    }
}

export const memoryMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    // 假设从鉴权中间件或上下文中获取 userId
    const userId = req.user?.userId;
    let memoryKey: string;

    if (userId) {
        // 场景 A：用户已登录，使用 userId 作为标识
        memoryKey = generateMemoryKey(userId);
    } else {
        // 场景 B：用户未登录（匿名访客）

        // 1. 优先检查请求中是否已经携带了匿名 memory_key Cookie
        memoryKey = req.cookies?.memory_key;

        // 2. 如果 Cookie 中不存在，则生成一个新的随机 Key
        if (!memoryKey || !memoryKey.startsWith(SESSION_KEY_PREFIX)) {
            // 使用加密安全的随机字节生成 16 字节的十六进制字符串
            const temporaryID = crypto.randomBytes(16).toString('hex');
            memoryKey = generateMemoryKey(temporaryID);
        }
    }

    // 3. 将新生成的 memory_key 注入到客户端的 Cookie 中
    res.cookie('memory_key', memoryKey, {
        httpOnly: true, // 防止 XSS 攻击，禁止 JS 读取
        // secure: true, // 仅在 HTTPS 下传输（本地测试如果是 HTTP 请改为 false）
        sameSite: 'strict', // 防止 CSRF 攻击
        maxAge: COOKIE_MEMORY_KEY_MAX_AGE,
    });
    req.user = { ...req.user, memoryKey };

    next();
};

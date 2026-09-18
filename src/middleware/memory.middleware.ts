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
                /** 上下文域：write 才启用写工具；缺省/非法一律 chat（失败关闭） */
                mode?: 'chat' | 'write';
                /** 写模式的笔记作用域；chat 模式恒为 undefined（避免误打笔记标签） */
                noteId?: string;
                /** 写模式的 run 标识（同一 run 多轮共享）；chat 模式恒为 undefined */
                runId?: string;
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

    // 上下文域（mode/noteId/runId）统一在此收敛：只进 req.meta，
    // 绝不写入 messages 数组，避免污染 RawMessage（设计 D3）。
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 失败关闭：缺省或非法 mode 一律按 chat 处理（不启用工具）
    const mode: 'chat' | 'write' = body.mode === 'write' ? 'write' : 'chat';

    // noteId 仅写模式接收：chat 模式即便 body 带了也忽略，避免 chat 消息被误打笔记标签
    const noteId =
        mode === 'write' && typeof body.noteId === 'string'
            ? body.noteId
            : undefined;

    // runId：写模式沿用客户端回传值（保证同一 run 多轮共享同一 runId），缺失则由中间件 mint；
    // chat 模式既不接收也不 mint、恒为 undefined（避免 chat 消息被误打 run 标签）。
    // 非字符串/空串一律视为未带（失败关闭，不落脏值，写模式下回落 mint）
    let runId: string | undefined;
    if (mode === 'write') {
        runId =
            typeof body.runId === 'string' && body.runId
                ? body.runId
                : crypto.randomBytes(16).toString('hex');
    }

    req.meta = { sessionId, mode, noteId, runId };

    next();
};

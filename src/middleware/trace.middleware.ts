import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { generateTraceId } from '@/util/tool';

// 扩展 Express 的 Request 类型
declare global {
    namespace Express {
        interface Locals {
            traceId: string;
        }
    }
}

export const traceMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    // 1. 优先从请求头获取（支持网关透传，方便全链路追踪）
    // 2. 如果没有，则自动生成一个 UUID
    const traceId = (req.headers['x-trace-id'] as string) || generateTraceId();

    // 3. res.locals 上设置的变量在单个请求-响应周期内可用，并且不会在请求之间共享。
    res.locals.traceId = traceId;

    // 4. 将 traceId 放入响应头，方便前端排查问题时提供 ID
    res.setHeader('X-Trace-Id', traceId);

    next();
};

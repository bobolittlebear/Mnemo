import { Request, Response } from 'express';
import redisClient from '@/lib/redis';
import ApiResponse from '@/utils/apiResponse';
import { SESSION_TTL_SECONDS, UNKNOWN_ERROR } from '@/utils/constant';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ltm');

/** sessionId 白名单：仅允许字母数字、下划线、连字符 */
const SID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function createSession(req: Request, res: Response): Promise<void> {
    try {
        const { sessionId } = req.body;
        const userId = req.user?.userId;

        // sessionId 必填 + 格式校验（防 Redis key 注入）
        if (!sessionId || typeof sessionId !== 'string' || !SID_PATTERN.test(sessionId)) {
            res.status(400).json(ApiResponse.error('sessionId 无效：必填且仅允许字母、数字、下划线、连字符'));
            return;
        }

        // userId 由 authMiddleware 注入，缺失说明未认证
        if (!userId) {
            res.status(401).json(ApiResponse.error('未认证'));
            return;
        }

        const key = `session:user:${sessionId}`;
        // NX: 仅 key 不存在时写入，保证幂等；EX: 设置过期时间
        await redisClient.set(key, String(userId), { NX: true, EX: SESSION_TTL_SECONDS });

        logger.info('session 映射已创建', { sessionId, userId });

        res.status(200).json(ApiResponse.success({ ok: true }));
    } catch (error) {
        logger.error('创建 session 映射失败', error instanceof Error ? error : new Error(String(error)));
        res.status(500).json(
            ApiResponse.error(error instanceof Error ? error.message : UNKNOWN_ERROR),
        );
    }
}

export default { createSession };

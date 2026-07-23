// src/services/chat/chatHistory.service.ts
import { createLogger } from '@/lib/logger';
import ChatMessage from '@/models/ChatMessage';
import { HistoryMessage } from '@/types/chat';
import STM from '@/utils/shortTermMemory';
import mongoose from 'mongoose';
import { sessionEndTrigger, sessionMemoryLifecycle } from '@/services/memory';

const logger = createLogger('ltm');

export default {
    /**
     * 获取历史消息（按 _id 游标分页，返回正序列表）
     */
    async getHistory(
        sessionId: string,
        limit: number,
        beforeId?: string,
    ): Promise<HistoryMessage[]> {
        const query: Record<string, unknown> = { sessionId };

        if (beforeId && mongoose.Types.ObjectId.isValid(beforeId)) {
            query._id = { $lt: new mongoose.Types.ObjectId(beforeId) };
        }

        const messages = await ChatMessage.find(query)
            .sort({ _id: -1 }) // 先倒序取最新的 limit 条
            .limit(limit)
            .lean();

        // 反转为正序（旧 → 新）
        messages.reverse();

        return messages.map((msg) => ({
            id: msg._id.toString(),
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.timestamp).toISOString(),
            msgId: msg.msgId,
            traceId: msg.traceId,
        }));
    },

    /**
     * 彻底清空当前用户的会话记录（Redis STM + MongoDB）
     * 触发场景 用户点击“删除对话”、GDPR/个保法请求、账号注销
     */
    async clearAll(sessionId: string) {
        await STM.clearSession(sessionId);

        const result = await ChatMessage.deleteMany({ sessionId });
        logger.info('Chat History cleared', {
            deletedCount: result.deletedCount,
            sessionId,
        });

        // 销毁会话触发器状态：清除全部 5 个 trigger key（lock/extracted/processing/msgCount/lastActiveAt）
        await sessionMemoryLifecycle.destroy(sessionId);
        return { deletedCount: result.deletedCount };
    },

    /**
     * 结束会话（仅清除 Redis STM，保留 MongoDB 历史）
     * 触发场景	session超时、任务完成、任务归档
     */
    async endSession(sessionId: string) {
        await STM.clearSession(sessionId);
        // L1 显性触发：STM 清除后立即触发终态提取，写入 extracted 标记。
        await sessionEndTrigger.end(sessionId);
    },
};

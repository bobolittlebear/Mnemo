// src/services/chat/chatHistory.service.ts
import { createLogger } from '@/lib/logger';
import ChatMessage from '@/models/ChatMessage';
import { HistoryMessage } from '@/types/chat';
import STM from '@/utils/shortTermMemory';
import mongoose from 'mongoose';

const logger = createLogger('ltm');

export default {
    /**
     * 获取历史消息（按 _id 游标分页，返回正序列表）
     */
    async getHistory(
        memoryKey: string,
        limit: number,
        beforeId?: string,
    ): Promise<HistoryMessage[]> {
        const query: Record<string, unknown> = { memoryKey };

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
     */
    async clearAll(memoryKey: string) {
        await STM.clearSession(memoryKey);

        const result = await ChatMessage.deleteMany({ memoryKey });
        logger.info('Chat History cleared', {
            deletedCount: result.deletedCount,
            memoryKey,
        });
        return { deletedCount: result.deletedCount };
    },

    /**
     * 结束会话（仅清除 Redis STM，保留 MongoDB 历史）
     */
    async endSession(memoryKey: string) {
        await STM.clearSession(memoryKey);
    },
};

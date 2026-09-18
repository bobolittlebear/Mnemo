// src/services/chat/chatHistory.service.ts
import { createLogger } from '@/lib/logger';
import ChatMessage from '@/models/ChatMessage';
import Session from '@/models/Session';
import { HistoryMessage } from '@/types/chat';
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
        const query: Record<string, unknown> = { sessionId, isDeleted: false };

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
            // 写模式新字段（M-D1）：find().lean() 未做字段投影，六个字段本就在结果里，
            // 直接取即可（不新增 .select()——省下了投影就不必再挑一次字段）。
            // chat 消息不含这些字段，取出来是 undefined，前端据此走普通气泡分支
            mode: msg.mode,
            noteId: msg.noteId,
            runId: msg.runId,
            toolCalls: msg.toolCalls,
            toolCallId: msg.toolCallId,
            result: msg.result,
        }));
    },

    /**
     * 彻底清空当前用户的会话记录（Redis STM + MongoDB）
     * 触发场景 用户点击“删除对话”、GDPR/个保法请求、账号注销
     */
    async clearAll(props: { sessionId: string; userId: string }) {
        const { sessionId } = props || {};

        // L1 显性触发 立即触发终态提取，写入 extracted 标记后清除STM
        await sessionEndTrigger.end(sessionId);

        //  软删除 mongodb 中持久化的消息
        const result = await ChatMessage.updateMany(
            { sessionId, isDeleted: { $ne: true } }, // 过滤条件：排除已软删除的记录
            {
                $set: {
                    isDeleted: true,
                },
            },
        );
        logger.info('Chat History cleared', {
            sessionId,
            deletedCount: result.modifiedCount,
        });

        // 销毁会话触发器状态：清除全部 5 个 trigger key
        await sessionMemoryLifecycle.destroy(sessionId);

        // 标记会话为已删除
        Session.updateOne({ sessionId }, { $set: { status: 'deleted' } }).catch(
            () => {},
        );

        return { deletedCount: result.modifiedCount };
    },

    /**
     * 结束会话（仅清除 Redis STM，保留 MongoDB 历史）
     * 触发场景	session超时、任务完成、任务归档
     */
    async endSession(props: { sessionId: string; userId: string }) {
        const { sessionId } = props || {};
        // L1 显性触发 立即触发终态提取，写入 extracted 标记后清除STM
        await sessionEndTrigger.end(sessionId);

        // 标记会话为已归档
        Session.updateOne(
            { sessionId },
            { $set: { status: 'archived' } },
        ).catch(() => {});
    },
};

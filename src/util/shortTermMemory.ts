// src/util/shortTermMemory.ts
/**
 * 简单的短期内存管理器（内存中 LRU 样式，带 TTL 与大小上限）
 * 目的：在 Express 请求生命周期中保存最近若干轮对话，按时间正序组装进 System Prompt
 */
import redisClient from '@/lib/redis';
import logger from '@/lib/logger';
import {
    MAX_MESSAGE_PER_SESSION,
    SESSION_TTL_SECONDS,
    LAST_EXTRACTED_MSG_KEY_PREFIX,
} from './constant';
import { randomUUID } from 'crypto';

type Role = 'system' | 'user' | 'assistant' | string;

export type STMMessage = {
    id: string; // 全局唯一消息ID
    role: Role;
    content: string;
    timestamp: number;
    traceId?: string;
};

class ShortTermMemory {
    private maxMessagesPerSession: number;
    private sessionTTLSeconds: number;

    constructor({
        maxMessagesPerSession = MAX_MESSAGE_PER_SESSION,
        sessionTTLSeconds = SESSION_TTL_SECONDS,
    } = {}) {
        this.maxMessagesPerSession = maxMessagesPerSession;
        this.sessionTTLSeconds = sessionTTLSeconds;
    }

    /**
     * 添加消息数组到 Redis List
     */
    async addMessages(
        id: string,
        messages: Array<Partial<STMMessage>>,
        traceId?: string,
    ) {
        try {
            if (
                !id ||
                !messages ||
                !Array.isArray(messages) ||
                messages.length === 0
            )
                return;

            const pipeline = redisClient.multi(); // 使用 Pipeline 减少网络 RTT
            for (const m of messages) {
                if (!m || !m.role || m.content == null) continue;
                const payload: STMMessage = {
                    id: m.id || randomUUID(), // 优先使用传入的ID，否则自动生成UUID
                    role: m.role,
                    content: String(m.content),
                    timestamp: m.timestamp || Date.now(),
                    traceId: m.traceId || traceId, // ✅ 优先使用消息自身的，其次使用批量注入的
                };
                pipeline.rPush(id, JSON.stringify(payload)); // 尾部追加，插入顺序 = 时间顺序
            }
            // 仅保留最近的 N 条消息（实现 LRU 截断）
            pipeline.lTrim(id, -this.maxMessagesPerSession, -1);
            // 刷新/设置 TTL
            pipeline.expire(id, this.sessionTTLSeconds);

            await pipeline.exec();
        } catch (err) {
            logger.warn('STM addMessages error', err);
        }
    }

    /**
     * 获取最近 N 轮对话（以 user 消息为计数基准）
     */
    async getRecentRounds(id: string, rounds = 10): Promise<STMMessage[]> {
        try {
            if (!id) return [];

            // 1. 获取该会话的所有消息（由于有 lTrim 限制，数据量可控）
            const rawMessages = await redisClient.lRange(id, 0, -1);
            if (!rawMessages || rawMessages.length === 0) return [];

            // 2. 解析 JSON
            const parsedMessages: STMMessage[] = rawMessages.map((msg) =>
                JSON.parse(msg),
            );

            // 3. 从后向前遍历，收集 rounds 个 user 消息
            const res: STMMessage[] = [];
            let userCount = 0;
            for (let i = parsedMessages.length - 1; i >= 0; i--) {
                const m = parsedMessages[i]!;
                res.push(m);
                if (m.role === 'user') {
                    userCount++;
                    if (userCount >= rounds) break;
                }
            }
            // 返回时间正序
            return res.reverse();
        } catch (err) {
            logger.warn('STM getRecentRounds error', err);
            return [];
        }
    }

    // 手动清理会话
    async clearSession(id: string) {
        logger.info(`[EndSession] Clearing STM key: ${id}`);
        await redisClient.del(id);
    }

    /**
     * 设置上次提取记忆的messageID
     * 使用独立的 Redis Key 存储游标，避免与消息列表耦合
     */
    async setLastExtractedMsgId(sessionId: string, msgId: string) {
        try {
            if (!sessionId || !msgId) return;
            const lastExtractedKey = `${LAST_EXTRACTED_MSG_KEY_PREFIX}${sessionId}`;
            const pipeline = redisClient.multi();
            pipeline.set(lastExtractedKey, msgId);
            pipeline.expire(lastExtractedKey, this.sessionTTLSeconds); // 游标TTL与会话保持一致
            await pipeline.exec();
        } catch (err) {
            logger.warn('STM setLastExtractedMsgId error', err);
        }
    }

    /**
     * 获取上次提取的消息ID
     */
    async getLastExtractedMsgId(sessionId: string): Promise<string | null> {
        try {
            if (!sessionId) return null;
            return await redisClient.get(
                `${LAST_EXTRACTED_MSG_KEY_PREFIX}${sessionId}`,
            );
        } catch (err) {
            logger.warn('STM getLastExtractedMsgId error', err);
            return null;
        }
    }
}

const defaultSTM = new ShortTermMemory();
export default defaultSTM;

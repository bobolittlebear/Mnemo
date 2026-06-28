// src/controllers/chat.controller.ts
import { Request, Response } from 'express';
import { createStreamChat } from '../service/ai.service';
import logger from '../lib/logger';
import { StreamCleaner } from '@/util/streamCleaner';
import STM, { STMMessage } from '@/util/shortTermMemory';
import ApiResponse from '@/util/apiResponse';
import { TIMEOUT_MS, UNKNOWN_ERROR } from '@/util/constant';
import ChatMessage from '@/models/ChatMessage';
import mongoose from 'mongoose';
import type {
    ChatCompletionMessageParam,
    ChatCompletionChunk,
} from 'openai/resources/chat/completions';

// 配置：短期记忆要注入的最近轮数
const SHORT_TERM_ROUNDS = Number(process.env.STM_ROUNDS || 10);

const chat = async (req: Request, res: Response) => {
    // 为每个请求创建一个独立的清洗器实例
    const cleaner = new StreamCleaner();
    try {
        // 从 res.locals 中安全获取由中间件生成的 traceId
        const traceId = res.locals.traceId;
        const rawMessages = Object.values(
            req.body?.messages || [],
        ) as ChatCompletionMessageParam[];
        const messages: ChatCompletionMessageParam[] = Array.isArray(
            rawMessages,
        )
            ? rawMessages
            : [];

        if (!messages || !Array.isArray(messages)) {
            logger.error('Invalid messages format:', messages);
            return res.status(400).json({ error: 'Invalid messages format' });
        }

        // 1. 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // 关键：防止 Nginx 等反向代理缓冲流数据

        // 2. 从短期记忆检索最近对话并组装 System Prompt
        const memoryKey = req.user.memoryKey!; // 中间件已处理过, 能够保证有值
        const recent = await safeGetRecentRounds(memoryKey, SHORT_TERM_ROUNDS);

        // 将 recent 转换为 LLM messages（按时间正序）并插入到当前 messages 之前
        const systemInjected = recent.map((m) => ({
            role: m.role,
            content: m.content,
        })) as ChatCompletionMessageParam[];
        const finalMessages: ChatCompletionMessageParam[] = [
            ...systemInjected,
            messages[messages.length - 1],
        ].filter(Boolean) as ChatCompletionMessageParam[];

        logger.info('Received chat request', finalMessages);

        // 3. 发起 AI 流请求
        const stream = (await createStreamChat(finalMessages, {
            traceId,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
        // 【关键】用于收集完整的 AI 回复
        let fullAssistantResponse = '';
        // let assistantContent = '';
        // let lastMsgId: string | null = null;

        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || '';
            if (content) {
                // 【关键步骤】调用清洗器
                const { cleaned, isDuplicate } = cleaner.clean(content);
                // 只有当清洗后有内容，且不是完全重复时，才发送给前端
                if (cleaned && !isDuplicate) {
                    res.write(
                        `data: ${JSON.stringify({ content: cleaned })}\n\n`,
                    );
                    fullAssistantResponse += cleaned; // 累加完整的回复内容
                }

                // 提取 usage（最后一个 chunk）
                // const usage = extractUsageFromChunk(chunk);
                // if (usage) {
                //     // 可选：记录 token 消耗日志
                // }
            }
        }

        // 4. 流结束后持久化数据
        if (fullAssistantResponse.trim()) {
            try {
                const memoryKey = req.user.memoryKey!;
                const now = Date.now();

                // 提取本次对话中最新的 User 消息（即触发本次请求的消息）
                const latestUserMsg = messages[messages.length - 1]!;

                const docsToSave: Array<Partial<STMMessage>> = [
                    // 保存用户刚才发的消息（防止之前没存进去）
                    {
                        role: 'user',
                        content: latestUserMsg.content as string,
                        timestamp: now, // 使用当前时间
                        traceId,
                    },
                    // 保存刚刚生成的完整 AI 回答
                    {
                        role: 'assistant',
                        content: fullAssistantResponse,
                        timestamp: now + 1, // 强制比用户消息晚 1ms，保证排序正确
                        traceId,
                    },
                ];
                // 并行写入 Redis 和 MongoDB
                // 使用 Promise.all 确保两者都尝试写入
                await Promise.all([
                    STM.addMessages(memoryKey, docsToSave).catch((e) =>
                        logger.warn('Redis STM save failed', e),
                    ),
                    ChatMessage.insertMany(docsToSave, { ordered: true }).catch(
                        (e) => logger.warn('MongoDB save failed', e),
                    ),
                ]);
                // 写入成功后，触发滑动窗口清理
                // 这里依然不需要 await，清理是后台任务
                ChatMessage.trimOldMessages(memoryKey, 100).catch((e) =>
                    logger.warn('Trim messages error', e),
                );
            } catch (error) {
                logger.error(
                    'Failed to save chat history after stream:',
                    error,
                );
                // 即使保存失败，也不应该中断给前端的流，因为用户已经看到了内容
            }
        }

        // 4. 发送结束标记
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error: any) {
        console.error('Stream Chat Error:', error);
        // 如果还没发送响应头，可以返回错误 JSON；如果已经开始流式传输，只能断开连接
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        } else {
            res.end();
        }
    }
};

// 带超时的安全读取方法
async function safeGetRecentRounds(
    id: string,
    rounds: number,
    timeoutMs = TIMEOUT_MS,
): Promise<STMMessage[]> {
    return Promise.race([
        STM.getRecentRounds(id, rounds),
        new Promise<STMMessage[]>((resolve) =>
            setTimeout(() => resolve([]), timeoutMs),
        ),
    ]);
}

const endSession = async (req: Request, res: Response) => {
    try {
        const memoryKey = req.cookies.memory_key;
        if (memoryKey) {
            // 1. 仅清除 Redis 中的短期记忆（STM）
            await STM.clearSession(memoryKey);
        }
        // 2. 无论有没有 memoryKey，都直接返回成功。前端只需要知道“当前聊天窗口被重置了”
        res.json(ApiResponse.success({}));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

/**
 * 获取历史消息（修复版）
 * GET /stream/chat/history?limit=20&before_id=64a...
 */
const getChatHistory = async (req: Request, res: Response) => {
    try {
        const memoryKey = req.user?.memoryKey!;
        const limit = Math.min(Number(req.query?.limit) || 20, 100); // 限制最大拉取数量
        const beforeId = req.query?.before_id as string; // 使用 _id 作为游标，而不是时间戳

        // 构建查询条件
        const query: any = { memoryKey };

        // 如果有游标，查询该 ID 之前的消息（利用 _id 的单调递增特性）
        if (beforeId && mongoose.Types.ObjectId.isValid(beforeId)) {
            query._id = { $lt: new mongoose.Types.ObjectId(beforeId) };
        }

        // 1. 按 _id 倒序查找（最新的在最前面）
        // 注意：这里不需要 reverse()，因为我们只需要把数据给前端，让前端决定怎么插
        // 但通常为了配合前端的 unshift (插入头部)，我们保持数据库里的倒序返回即可
        // 或者：如果你希望返回正序（旧->新），就 sort({ _id: 1 })
        // 这里建议：返回 旧 -> 新 (Ascending)，方便前端直接渲染列表
        const messages = await ChatMessage.find(query)
            .sort({ _id: -1 }) // 先倒序取最新的 limit 条
            .limit(limit)
            .select('role content timestamp') // 不要排除 _id，也不要排除 timestamp
            .lean(); // 使用 lean() 提高性能，返回纯 JSON 对象

        // 2. 在内存中将数组反转为正序（旧 -> 新）
        // 这样前端拿到的数组 index 0 是最早的，index N 是最新的
        messages.reverse();

        // 3. 格式化数据
        const formattedMessages = messages.map((msg) => ({
            id: msg._id.toString(), // 必须返回 ID，用于前端去重和作为下次查询的游标
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.timestamp).toISOString(),
        }));

        res.json(ApiResponse.success(formattedMessages));
    } catch (error) {
        console.error(error);
        res.status(500).json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

// src/controllers/chat.controller.ts

/**
 * 彻底清空当前用户的会话记录（测试专用）
 * DELETE /stream/chat/clear
 */
const clearChatHistory = async (req: Request, res: Response) => {
    try {
        const memoryKey = req.user.memoryKey!;

        // 1. 清除 Redis STM
        await STM.clearSession(memoryKey);

        // 2. 清除 MongoDB 历史记录
        const result = await ChatMessage.deleteMany({ memoryKey });
        logger.info(
            `[ClearHistory] Cleared ${result.deletedCount} messages for key: ${memoryKey}`,
        );

        res.json(ApiResponse.success({ deletedCount: result.deletedCount }));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export { chat, endSession, getChatHistory, clearChatHistory };

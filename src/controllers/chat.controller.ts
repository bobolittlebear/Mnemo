// src/controllers/chat.controller.ts
import { Request, Response } from 'express';
import { createStreamChat } from '../services/ai.service';
import { createLogger } from '@/lib/logger';
import { StreamCleaner } from '@/utils/streamCleaner';
import STM, { STMMessage } from '@/utils/shortTermMemory';
import ApiResponse from '@/utils/apiResponse';
import { TIMEOUT_MS, UNKNOWN_ERROR } from '@/utils/constant';
import ChatMessage from '@/models/ChatMessage';
import mongoose from 'mongoose';
import type {
    ChatCompletionMessageParam,
    ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import { generateEmbeddings } from '@/lib/embedding';

// 配置：短期记忆要注入的最近轮数
const SHORT_TERM_ROUNDS = Number(process.env.STM_ROUNDS || 10);
const logger = createLogger('api');

const chat = async (req: Request, res: Response) => {
    // 为每个请求创建一个独立的清洗器实例
    const cleaner = new StreamCleaner();
    const startTime = Date.now();

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
            logger.warn('Invalid messages format', { traceId, body: req.body });
            return res.status(400).json({ error: 'Invalid messages format' });
        }

        const latestUserMsg = messages[messages.length - 1]!;
        const memoryKey = req.user.memoryKey!; // 中间件已处理过, 能够保证有值

        // 1. 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // 关键：防止 Nginx 等反向代理缓冲流数据

        // 2. 从短期记忆检索最近对话并组装 System Prompt
        const recent = await safeGetRecentRounds(memoryKey, SHORT_TERM_ROUNDS);

        // 将 recent 转换为 LLM messages（按时间正序）并插入到当前 messages 之前
        const systemInjected = recent.map((m) => ({
            role: m.role,
            content: m.content,
        })) as ChatCompletionMessageParam[];
        const finalMessages: ChatCompletionMessageParam[] = [
            ...systemInjected,
            latestUserMsg,
        ].filter(Boolean) as ChatCompletionMessageParam[];

        // 3. 发起 AI 流请求
        const stream = (await createStreamChat(finalMessages, {
            traceId,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;

        let fullAssistantResponse = '';
        // catch 块中不置 true，确保只有正常结束的流才会触发 STM 写入
        let streamCompleted = false;

        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || '';
            if (chunk.choices[0]?.finish_reason === 'content_filter') {
                logger.warn('Content filter triggered', { traceId });
            }
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
            }
        }
        // 仅在 for-await 完整消费（无中途异常）后置 true
        streamCompleted = true;

        // 延迟写入：仅在 streamCompleted && 有实际回复内容时，才将 User + Assistant 一起写入 STM
        if (streamCompleted && fullAssistantResponse.trim()) {
            // 内层 try-catch 包裹 Redis 同步写入，失败仅 log.warn，不中断响应
            try {
                const now = Date.now();

                const docsToSave: Array<Partial<STMMessage>> = [
                    {
                        role: 'user',
                        content: latestUserMsg.content as string,
                        timestamp: now,
                        traceId,
                    },
                    {
                        role: 'assistant',
                        content: fullAssistantResponse,
                        // RPUSH 已经保证了 User 在 Assistant 前面
                        timestamp: now,
                        traceId,
                    },
                ];

                // Redis 必须 await 同步写入，确保下一轮请求能读到完整上下文
                await STM.addMessages(memoryKey, docsToSave);
            } catch (error) {
                logger.warn('STM save failed', {
                    traceId,
                    component: 'redis',
                    memoryKey,
                    error,
                });
            }

            // MongoDB 写入 + 清理作为后台任务，不阻塞响应结束
            // 使用 setImmediate 将其推入下一个事件循环（macro task）
            setImmediate(() => {
                ChatMessage.insertMany(
                    [
                        {
                            role: 'user',
                            content: latestUserMsg.content as string,
                            timestamp: Date.now(),
                            traceId,
                            memoryKey,
                        },
                        {
                            role: 'assistant',
                            content: fullAssistantResponse,
                            timestamp: Date.now(),
                            traceId,
                            memoryKey,
                        },
                    ],
                    { ordered: true },
                )
                    .then(() => ChatMessage.trimOldMessages(memoryKey, 100))
                    .catch((error) =>
                        logger.warn('ChatMessage save/trim failed', {
                            traceId,
                            component: 'mongodb',
                            memoryKey,
                            error,
                        }),
                    );
            });
        }

        // SSE 协议规范化：正常结束发送 event: done
        res.write('event: done\ndata: [DONE]\n\n');
        res.end();
    } catch (error: any) {
        logger.error('Stream chat failed', {
            traceId: res.locals.traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
        // 错误分级处理
        if (!res.headersSent) {
            // 响应头尚未发送 → 返回标准 JSON 错误
            res.status(500).json({ error: 'Internal Server Error' });
        } else {
            // 响应头已发送（流已开始）→ 发送 SSE event: error 后结束
            // streamCompleted 保持 false，不会触发 STM 写入，避免上下文污染
            try {
                res.write(
                    `event: error\ndata: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`,
                );
            } catch (_) {
                // 连接可能已断开，忽略写入失败
            }
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
    const startTime = Date.now();
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
        logger.error('Get stream chat history failed', {
            traceId: res.locals.traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
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
        logger.info(`Chat History cleared`, {
            deletedCount: result.deletedCount,
            memoryKey,
        });

        res.json(ApiResponse.success({ deletedCount: result.deletedCount }));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

/**
 * 生成向量化数据
 * PUT /stream/embedding
 */
const createVector = async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
        const text = req.body?.text || [];

        const vectors = await generateEmbeddings(text);
        res.json(ApiResponse.success({ vectors }));
    } catch (error) {
        logger.error('Get stream chat history failed', {
            traceId: res.locals.traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
        res.status(500).json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export { chat, endSession, getChatHistory, clearChatHistory, createVector };

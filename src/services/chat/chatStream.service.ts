// src/services/chat/chatStream.service.ts
import { createStreamChat } from '@/services/ai.service';
import { createLogger } from '@/lib/logger';
import { StreamCleaner } from '@/utils/streamCleaner';
import STM from '@/utils/shortTermMemory';
import ChatMessage from '@/models/ChatMessage';
import { messageCounter, sessionMemoryLifecycle } from '@/services/memory';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { RawMessage } from '@/types/chat';
import { generateMessageId } from '@/utils/tool';

/** 短期记忆注入的最近轮数 */
const SHORT_TERM_ROUNDS = Number(process.env.STM_ROUNDS || 10);
const logger = createLogger('ltm');

class ChatStreamService {
    /**
     * 执行流式对话的完整业务逻辑：
     * 1. 构建上下文（STM 近期对话）
     * 2. 创建并消费 AI 流
     * 3. 持久化对话记录（STM 同步 + MongoDB 后台）
     *
     * @param sessionId  用户会话标识(无前缀)
     * @param messages   请求中的消息列表
     * @param traceId    请求追踪 ID
     * @param onChunk    清洗后的内容回调（由 Controller 写入 SSE）
     */
    async streamChat(props: {
        sessionId: string;
        messages: RawMessage[];
        traceId: string;
        onChunk: (content: string) => void;
    }): Promise<void> {
        const { messages, traceId, sessionId, onChunk } = props || {};
        const cleaner = new StreamCleaner();
        const latestUserMsg = messages[messages.length - 1]!;

        // 续聊 O10：若上一轮已落终态标记，清终态+计数，并清 STM 消息列表，
        // 使本轮按新会话上下文进行。resetForContinuation 内部已 try/catch。
        const continued =
            await sessionMemoryLifecycle.resetForContinuation(sessionId);
        if (continued) {
            await STM.clearSession(sessionId);
        }

        // 1. 从短期记忆检索最近对话并组装上下文
        const recent = await STM.safeGetRecentRounds(
            sessionId,
            SHORT_TERM_ROUNDS,
        );
        const systemInjected: Partial<RawMessage>[] = recent.map((m) => ({
            role: m.role,
            content: m.content,
            msgId: m.msgId,
        }));
        const finalMessages = [...systemInjected, latestUserMsg].filter(
            Boolean,
        );

        const assistantMsgId = generateMessageId();
        // 2. 发起 AI 流并逐块消费
        const stream = (await createStreamChat(finalMessages, {
            metadata: {
                traceId,
                msgId: assistantMsgId,
            },
        })) as unknown as AsyncIterable<ChatCompletionChunk>;

        let fullAssistantResponse = '';

        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || '';
            if (chunk.choices[0]?.finish_reason === 'content_filter') {
                logger.warn('Content filter triggered', { traceId });
            }
            if (content) {
                const { cleaned, isDuplicate } = cleaner.clean(content);
                if (cleaned && !isDuplicate) {
                    onChunk?.(cleaned);
                    fullAssistantResponse += cleaned;
                }
            }
        }

        // 3. 持久化（仅在流正常消费完毕后执行）
        if (fullAssistantResponse.trim()) {
            await this.persistConversation({
                sessionId,
                latestUserMsg,
                assistantMsg: {
                    content: fullAssistantResponse,
                    msgId: assistantMsgId,
                },
                traceId,
            });
        }
    }

    /**
     * 持久化本轮对话：STM 同步写入 + MongoDB 后台写入
     */
    private async persistConversation(props: {
        sessionId: string;
        latestUserMsg: RawMessage;
        assistantMsg: {
            content: string;
            msgId: string;
        };
        traceId: string;
    }): Promise<void> {
        const { sessionId, traceId, latestUserMsg, assistantMsg } = props || {};
        const now = Date.now();

        // STM 必须同步写入，确保下一轮请求能读到完整上下文
        try {
            const docsToSave: Array<Omit<RawMessage, 'id'>> = [
                {
                    role: 'user',
                    content: latestUserMsg.content as string,
                    timestamp: latestUserMsg.timestamp || now,
                    msgId: latestUserMsg.msgId,
                    traceId,
                },
                {
                    role: 'assistant',
                    content: assistantMsg.content,
                    timestamp: now,
                    msgId: assistantMsg.msgId,
                    traceId,
                },
            ];
            await STM.addMessages(sessionId, docsToSave);
        } catch (error) {
            logger.warn('STM save failed', {
                traceId,
                component: 'redis',
                sessionId,
                error,
            });
        }

        // 更新会话最后活跃时间（毫秒时间戳），为 L2 超时静默触发器提供数据源。
        // 不阻塞主流程，失败不影响落库（touch 内部已吞异常）。
        void sessionMemoryLifecycle.touch(sessionId);

        // MongoDB 写入放入下一个事件循环，不阻塞 SSE 响应结束
        setImmediate(() => {
            ChatMessage.insertMany(
                [
                    {
                        role: 'user',
                        content: latestUserMsg.content,
                        timestamp: Date.now(),
                        traceId,
                        sessionId,
                        msgId: latestUserMsg.msgId,
                    },
                    {
                        role: 'assistant',
                        content: assistantMsg.content,
                        timestamp: Date.now(),
                        traceId,
                        sessionId,
                        msgId: assistantMsg.msgId,
                    },
                ],
                { ordered: true },
            )
                .then(() => ChatMessage.trimOldMessages(sessionId, 100))
                .catch((error) =>
                    logger.warn('ChatMessage save/trim failed', {
                        traceId,
                        component: 'mongodb',
                        sessionId,
                        error,
                    }),
                );
        });

        // L3 兜底触发：消息落库后计数，达到阈值由 coordinator 触发增量提取。
        // 不阻塞主流程，失败不影响落库（record 内部已吞异常）。
        void messageCounter.record(sessionId);
    }
}

export default new ChatStreamService();

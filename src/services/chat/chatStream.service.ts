// src/services/chat/chatStream.service.ts
import { createStreamChat } from '@/services/ai.service';
import { createLogger } from '@/lib/logger';
import { StreamCleaner } from '@/utils/streamCleaner';
import STM, { type STMMessage } from '@/utils/shortTermMemory';
import ChatMessage from '@/models/ChatMessage';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';

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
     * @param memoryKey  用户会话标识
     * @param messages   请求中的消息列表
     * @param traceId    请求追踪 ID
     * @param onChunk    清洗后的内容回调（由 Controller 写入 SSE）
     */
    async streamChat(
        memoryKey: string,
        messages: ChatCompletionMessageParam[],
        traceId: string,
        onChunk: (content: string) => void,
    ): Promise<void> {
        const cleaner = new StreamCleaner();
        const latestUserMsg = messages[messages.length - 1]!;

        // 1. 从短期记忆检索最近对话并组装上下文
        const recent = await STM.safeGetRecentRounds(memoryKey, SHORT_TERM_ROUNDS);
        const systemInjected = recent.map((m) => ({
            role: m.role,
            content: m.content,
        })) as ChatCompletionMessageParam[];
        const finalMessages: ChatCompletionMessageParam[] = [
            ...systemInjected,
            latestUserMsg,
        ].filter(Boolean) as ChatCompletionMessageParam[];

        // 2. 发起 AI 流并逐块消费
        const stream = (await createStreamChat(finalMessages, {
            traceId,
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
                    onChunk(cleaned);
                    fullAssistantResponse += cleaned;
                }
            }
        }

        // 3. 持久化（仅在流正常消费完毕后执行）
        if (fullAssistantResponse.trim()) {
            await this.persistConversation(
                memoryKey,
                latestUserMsg,
                fullAssistantResponse,
                traceId,
            );
        }
    }

    /**
     * 持久化本轮对话：STM 同步写入 + MongoDB 后台写入
     */
    private async persistConversation(
        memoryKey: string,
        latestUserMsg: ChatCompletionMessageParam,
        fullAssistantResponse: string,
        traceId: string,
    ): Promise<void> {
        const now = Date.now();

        // STM 必须同步写入，确保下一轮请求能读到完整上下文
        try {
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
                    timestamp: now,
                    traceId,
                },
            ];
            await STM.addMessages(memoryKey, docsToSave);
        } catch (error) {
            logger.warn('STM save failed', {
                traceId,
                component: 'redis',
                memoryKey,
                error,
            });
        }

        // MongoDB 写入放入下一个事件循环，不阻塞 SSE 响应结束
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
}

export default new ChatStreamService();

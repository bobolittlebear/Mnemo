// src/services/chat/chatStream.service.ts
import { createStreamChat } from '@/services/ai.service';
import { createLogger } from '@/lib/logger';
import { StreamCleaner } from '@/utils/streamCleaner';
import STM from '@/utils/shortTermMemory';
import ChatMessage from '@/models/ChatMessage';
import Session from '@/models/Session';
import { messageCounter, sessionMemoryLifecycle } from '@/services/memory';
import memorySearchService from '@/services/memory/memorySearch.service';
import memorySelectionService from '@/services/memory/memorySelection.service';
import { injectNotesIntoSystemPrompt } from '@/services/notebook/noteInjection.service';
import { chatTools } from './tools';
import { persistWriteRound } from './writeModeContext.service';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { RawMessage } from '@/types/chat';
import { generateMessageId } from '@/utils/tool';

/** 短期记忆注入的最近轮数 */
const SHORT_TERM_ROUNDS = Number(process.env.STM_ROUNDS || 10);
const logger = createLogger('ltm');

/**
 * 拼接完成的工具调用（M-B1b）
 *
 * 不复用 SDK 的 ChatCompletionMessageToolCall：那里的 arguments 是 JSON 字符串，
 * 这里要的是前端可直接执行的结构化参数。
 */
interface SplicedToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        /** 解析失败时回退为原始字符串，见 safeParseToolArgs */
        arguments: Record<string, unknown> | string;
    };
}

/**
 * 拼接出的 arguments 是 JSON 字符串，解析失败不能让整轮崩：
 * 回退为原串并告警（调用方拿不到结构化参数时走执行失败路径）。
 */
function safeParseToolArgs(
    raw: string,
    index: number,
    traceId: string,
): Record<string, unknown> | string {
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        logger.warn('tool_call arguments 非合法 JSON，回退原串', {
            traceId,
            index,
            arguments: raw,
        });
        return raw;
    }
}

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
        userId: string;
        messages: RawMessage[];
        traceId: string;
        onChunk: (content: string) => void;
        /** 上下文域：write 才注入工具定义；缺省按 chat 处理（不启用工具） */
        mode?: 'chat' | 'write';
        /**
         * 一次用户指令引发的多轮调用共享的 run 标识。
         * 事件由 Controller 组装并自带 runId；本层只把它落到写模式消息上（M-C1）。
         * 由 req.meta 注入（M-C2）：写模式必有值，chat 模式恒为 undefined。
         */
        runId?: string;
        /**
         * 写模式的笔记作用域：装配与落库都按 {sessionId, mode, noteId} 收敛。
         * 与 mode/runId 同源（请求体顶层字段），非写模式一律 undefined。
         */
        noteId?: string;
        /**
         * 预装配的写模式上下文（M-C3）：由 Controller 调 assembleWriteContext 装配
         * （写模式 system prompt + 笔记全文 + 该笔记的历史），传入即跳过本层默认装配。
         * 装配归 Controller，本层不反向依赖 writeModeContext，避免双查 MongoDB。
         */
        writeContext?: { messages: RawMessage[]; systemPrompt: string };
        /** 每个拼接完成的工具调用回调一次（由 Controller 转成 tool_call 事件） */
        onToolCall?: (toolCall: SplicedToolCall) => void;
        /** 本轮流终态：等待客户端执行工具（取代该轮的 done） */
        onRunPaused?: () => void;
    }): Promise<void> {
        const {
            messages,
            traceId,
            sessionId,
            userId,
            onChunk,
            mode,
            runId,
            noteId,
            writeContext,
            onToolCall,
            onRunPaused,
        } = props || {};
        const cleaner = new StreamCleaner();

        // 写模式预装配覆盖（M-C3）：Controller 已按 {sessionId, noteId} 装配好完整上下文
        // （写模式 system prompt + 笔记全文 + 该笔记的全部写模式历史），此处直接采用，
        // 跳过 STM 检索 / 记忆检索 / 笔记 RAG 三条默认装配路径——它们面向 chat 模式，
        // 且写模式的上下文必须每轮从 MongoDB 重取（见 writeModeContext.service 文件头）。
        const isWritePrebuilt = mode === 'write' && !!writeContext;

        // 本轮的真实用户消息：仅请求体带 messages 的轮次有（首轮）。
        // 续轮 messages 为空（历史已在 writeContext 内），此时历史末位是 tool 消息，
        // 不能冒充 user 落库（设计 §3.4：一个 run 只有一个用户轮）。
        const roundUserMsg =
            messages && messages.length > 0
                ? messages[messages.length - 1]
                : undefined;

        let finalMessages: Partial<RawMessage>[];
        let systemPrompt: string | undefined;

        if (isWritePrebuilt) {
            finalMessages = writeContext!.messages;
            systemPrompt = writeContext!.systemPrompt;
        } else {
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
            finalMessages = [...systemInjected, latestUserMsg].filter(Boolean);

            // 记忆检索 → 选择 → 拼 system prompt
            try {
                const searchResult = await memorySearchService.search({
                    userId,
                    query: latestUserMsg.content as string,
                });
                const { selected, metadata } =
                    await memorySelectionService.select(searchResult.results);

                if (selected.length > 0) {
                    const today = new Date().toISOString().slice(0, 10);
                    const formatDate = (d: Date) =>
                        new Date(d).toISOString().slice(0, 10);
                    const xmlEscape = (s: string) =>
                        s
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;');

                    const memsXml = selected
                        .map(
                            (m) =>
                                `<mem category="${xmlEscape(m.category ?? '')}" learned="${formatDate(m.createdAt)}">${xmlEscape(m.content)}</mem>`,
                        )
                        .join('\n');

                    systemPrompt = `<memory_instructions>
请基于以下用户记忆提供个性化回答：
- 将记忆信息自然融入回答中，不要刻意提及"根据记忆"等表述
- 如果记忆与用户当前表述矛盾，以用户当前表述为准
- 不要编造记忆中没有的信息
</memory_instructions>
<user_memory count="${selected.length}" retrieved_at="${today}">
${memsXml}
</user_memory>`;

                    logger.info('会话记忆注入成功', {
                        totalCandidates: metadata.totalCandidates,
                        afterPercentile: metadata.afterPercentile,
                        afterDedup: metadata.afterDedup,
                        selected: selected.length,
                        memories: selected.map((i) => i.content),
                    });
                }
            } catch (error) {
                logger.warn('记忆注入失败，对话照常继续', { error });
                systemPrompt = undefined;
            }
            // 笔记 RAG 注入：在记忆注入之后追加 <note_context> 块。检索异常等由注入层内部降级，
            // 此处兜底不打断对话；抛错时 systemPrompt 保留已拼好的记忆 prompt。
            try {
                systemPrompt = await injectNotesIntoSystemPrompt({
                    userId,
                    query: latestUserMsg.content as string,
                    systemPrompt: systemPrompt ?? '',
                    // notebookId: 当前流式对话未绑定笔记本，暂不限定检索范围
                });
            } catch (error) {
                logger.warn('笔记注入失败，对话照常继续', { error });
            }
        }

        const assistantMsgId = generateMessageId();
        // 2. 发起 AI 流并逐块消费
        const stream = (await createStreamChat(finalMessages, {
            ...(systemPrompt ? { systemPrompt } : {}),
            metadata: {
                traceId,
                msgId: assistantMsgId,
            },
            // 仅写作模式注入工具（chat 模式保持 undefined，避免普通对话误触发工具）
            tools: mode === 'write' ? chatTools : undefined,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;

        let fullAssistantResponse = '';

        // tool_calls 流式拼接：按 chunk 自带的 index 归并（V1 单工具恒为 0，
        // 但按 index 累积以支持未来并行调用，不写死 0）
        const toolCallAcc = new Map<
            number,
            { id?: string; type?: string; name?: string; argsBuf: string }
        >();
        let finishReason: string | null | undefined;

        for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            const content = choice?.delta?.content || '';

            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }
            if (choice?.finish_reason === 'content_filter') {
                logger.warn('Content filter triggered', { traceId });
            }

            // 首帧带 id/name 与空 arguments，中帧只增量追加 arguments 片段，
            // 末帧回传 id: null 与空串 arguments——故一律"有值才写"，
            // 否则终止帧会清掉已拼好的 id 与参数。
            for (const tc of choice?.delta?.tool_calls ?? []) {
                const acc = toolCallAcc.get(tc.index) ?? { argsBuf: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.type) acc.type = tc.type;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                    acc.argsBuf += tc.function.arguments;
                }
                toolCallAcc.set(tc.index, acc);
            }

            if (content) {
                const { cleaned, isDuplicate } = cleaner.clean(content);
                if (cleaned && !isDuplicate) {
                    onChunk?.(cleaned);
                    fullAssistantResponse += cleaned;
                }
            }
        }

        // 工具轮收尾：逐个回调拼接结果，再声明本轮流终态。
        // run_paused 取代该轮的 done，Controller 据此不再补发 done。
        const splicedToolCalls: SplicedToolCall[] = [];
        const isToolRound =
            finishReason === 'tool_calls' || toolCallAcc.size > 0;
        if (isToolRound) {
            for (const [index, acc] of toolCallAcc) {
                const toolCall: SplicedToolCall = {
                    id: acc.id ?? `call_${index}`,
                    type: 'function',
                    function: {
                        name: acc.name ?? '',
                        arguments: safeParseToolArgs(
                            acc.argsBuf,
                            index,
                            traceId,
                        ),
                    },
                };
                splicedToolCalls.push(toolCall);
                onToolCall?.(toolCall);
            }
            onRunPaused?.();
        }

        // 3. 持久化（仅在流正常消费完毕后执行）
        // 写模式工具轮：assistant 通常无正文，落 user + assistant(toolCalls) 供下一轮装配；
        // 不写 STM——写模式上下文从 MongoDB 全量取，STM 形状承载不了 toolCalls
        if (mode === 'write' && isToolRound) {
            if (!noteId) {
                // 缺 noteId 无法按笔记收敛落库，宁可告警跳过也不落一条游离消息（M-C2 中间件应保证存在）
                logger.warn('写模式工具轮缺少 noteId，本轮不落库', {
                    traceId,
                    sessionId,
                    runId,
                });
            } else if (!runId) {
                // runId 由中间件 mint（M-C2）：缺失说明调用方绕过了中间件。
                // 无 run 标签的写模式消息无法按 run 聚合，与缺 noteId 同等处理（告警跳过）
                logger.warn('写模式工具轮缺少 runId，本轮不落库', {
                    traceId,
                    sessionId,
                    noteId,
                });
            } else {
                try {
                    await persistWriteRound({
                        sessionId,
                        userId,
                        noteId,
                        runId,
                        traceId,
                        // 首轮：请求体 messages 的末位即本轮用户指令；
                        // 续轮：messages 为空 → undefined，不把历史末位的 tool 消息当 user 落库
                        userMsg: roundUserMsg,
                        assistantMsg: {
                            content: fullAssistantResponse,
                            msgId: assistantMsgId,
                        },
                        // 存储侧保留结构化参数（解析失败的原串回退原样落库）
                        toolCalls: splicedToolCalls.map((tc) => ({
                            id: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        })),
                    });
                } catch (error) {
                    // 流已消费完毕（客户端已收到 run_paused），落库失败不该再炸掉本轮响应
                    logger.warn('写模式工具轮落库失败', {
                        traceId,
                        component: 'mongodb',
                        sessionId,
                        noteId,
                        runId,
                        error,
                    });
                }
            }
        } else if (fullAssistantResponse.trim()) {
            await this.persistConversation({
                sessionId,
                latestUserMsg: roundUserMsg,
                assistantMsg: {
                    content: fullAssistantResponse,
                    msgId: assistantMsgId,
                },
                traceId,
                mode,
                noteId,
                runId,
            });
        }
    }

    /**
     * 持久化本轮对话：STM 同步写入 + MongoDB 后台写入
     */
    private async persistConversation(props: {
        sessionId: string;
        /**
         * 本轮的用户消息。续轮（tool_result 触发的写模式轮次）没有新用户消息——
         * 一个 run 内只有一个用户轮（设计 §3.4），故为 undefined，此时不落 user 消息：
         * 否则历史末位的 tool 消息会被冒充成 user 落库，并污染下一轮写模式装配。
         */
        latestUserMsg?: RawMessage;
        assistantMsg: {
            content: string;
            msgId: string;
        };
        traceId: string;
        /**
         * 写模式的回复轮（无工具轮）也走本方法保留 STM/LTM 链路，
         * 但 Mongo 侧必须打上 mode/noteId/runId——否则下一轮写模式装配按
         * {mode:'write', noteId} 过滤时看不见这轮的总结文本，上下文断链。
         */
        mode?: 'chat' | 'write';
        noteId?: string;
        runId?: string;
    }): Promise<void> {
        const {
            sessionId,
            traceId,
            latestUserMsg,
            assistantMsg,
            mode,
            noteId,
            runId,
        } = props || {};
        const now = Date.now();
        // 只有写模式才打上下文域标签，chat 模式的落库形状保持不变
        const writeScope =
            mode === 'write' ? { mode, noteId, runId } : { mode };

        // STM 必须同步写入，确保下一轮请求能读到完整上下文
        try {
            const docsToSave: Array<Omit<RawMessage, 'id'>> = [
                ...(latestUserMsg
                    ? [
                          {
                              role: 'user',
                              content: latestUserMsg.content as string,
                              timestamp: latestUserMsg.timestamp || now,
                              msgId: latestUserMsg.msgId,
                              traceId,
                          },
                      ]
                    : []),
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

        // 同步更新 MongoDB Session 文档的 lastActiveAt，不阻塞，吞异常
        Session.updateOne(
            { sessionId },
            { $set: { lastActiveAt: new Date() } },
        ).catch(() => {});

        // MongoDB 写入放入下一个事件循环，不阻塞 SSE 响应结束
        setImmediate(() => {
            ChatMessage.insertMany(
                [
                    ...(latestUserMsg
                        ? [
                              {
                                  role: 'user',
                                  content: latestUserMsg.content,
                                  timestamp: Date.now(),
                                  traceId,
                                  sessionId,
                                  msgId: latestUserMsg.msgId,
                                  ...writeScope,
                              },
                          ]
                        : []),
                    {
                        role: 'assistant',
                        content: assistantMsg.content,
                        timestamp: Date.now(),
                        traceId,
                        sessionId,
                        msgId: assistantMsg.msgId,
                        ...writeScope,
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

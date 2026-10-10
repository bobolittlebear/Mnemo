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
import { retrieveNotes } from '@/services/notebook/noteInjection.service';
import ContextBudgeter, { buildSystemPrompt } from './tokenBudget.service';
import type { BudgetBill } from './tokenBudget.service';
import { chatTools } from './tools';
import { persistWriteRound } from './writeModeContext.service';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { RawMessage } from '@/types/chat';
import type { MemorySearchResult } from '@/types/memory';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import { generateMessageId } from '@/utils/tool';
import { countTokens } from '@/utils/tokenizer';
import { BUDGET_CONFIG } from '@/utils/config';

/**
 * 短期记忆注入的最近轮数。
 *
 * 默认值对齐设计声明的 STM 窗口（`BUDGET_CONFIG.stmWindowRounds` = 20 轮），
 * 不再用 10：预算器要在窗口内再切分 competitable / must-fit（最近
 * mustFitRecentRounds 轮不可丢），窗口若只比 must-fit 大一点，L2 就没得压。
 * 环境变量 STM_ROUNDS 仍可覆盖（运维临时收窄窗口用）。
 */
const SHORT_TERM_ROUNDS = Number(
    process.env.STM_ROUNDS || BUDGET_CONFIG.stmWindowRounds,
);
const logger = createLogger('ltm');

/**
 * W3 软闸埋点：把预算账单落成结构化日志，**只观测、不在此步硬裁**——
 * 真实分布出来之前先调阈值，比先砍一刀更安全。
 * chat / write 两条装配路径共用，保证同一份分布口径可比。
 */
function logBudgetBill(props: {
    sessionId: string;
    mode: string;
    model: string;
    bill: BudgetBill;
    startedAt: number;
}): void {
    logger.info('token budget bill', {
        sessionId: props.sessionId,
        mode: props.mode,
        model: props.model,
        inputBudget: props.bill.inputBudget,
        level: props.bill.level,
        mustFitCompressed: props.bill.mustFitCompressed,
        perBlock: props.bill.perBlock,
        stmWindowRounds: SHORT_TERM_ROUNDS,
        duration_ms: Date.now() - props.startedAt,
    });
}

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

        // 预算器：本层唯一的裁剪入口（设计 §11.4 集成点：三条检索之后、createStreamChat 之前）。
        // 模型未登记时构造即抛错——预算算错的后果比一次失败请求严重得多。
        const budgeter = new ContextBudgeter();

        if (isWritePrebuilt) {
            // 写模式同样纳入预算（设计 §9）：笔记全文超模型输入上限时退化为「标题 + 首部邻域」，
            // 而不是把请求直接打爆。上下文来自 writeModeContext 的预装配结果——
            // 末位即本轮送入模型的最后一条消息（首轮是用户指令，工具续轮是 tool 结果）。
            const prebuilt = writeContext!.messages;
            const basePrompt = writeContext!.systemPrompt ?? '';
            const startedAt = Date.now();
            const budgeted =
                prebuilt.length > 0
                    ? budgeter.assembleContext({
                          systemPrompt: basePrompt,
                          userMessage: prebuilt[prebuilt.length - 1]!,
                          stmRounds: prebuilt.slice(0, -1),
                          mode: 'write',
                      })
                    : undefined;
            finalMessages = budgeted ? budgeted.finalMessages : prebuilt;
            systemPrompt = budgeted
                ? buildSystemPrompt(
                      budgeted.systemPrompt,
                      budgeted.keptLtm,
                      budgeted.keptRag,
                  )
                : basePrompt;
            if (budgeted) {
                // 写模式的 system 块最容易撑爆（笔记全文本体），同样要落账单
                logBudgetBill({
                    sessionId,
                    mode: 'write',
                    model: budgeter.model,
                    bill: budgeted.bill,
                    startedAt,
                });
            }
        } else {
            const latestUserMsg = messages[messages.length - 1]!;
            const query = latestUserMsg.content as string;

            // 续聊 O10：若上一轮已落终态标记，清终态+计数，并清 STM 消息列表，
            // 使本轮按新会话上下文进行。resetForContinuation 内部已 try/catch。
            const continued =
                await sessionMemoryLifecycle.resetForContinuation(sessionId);
            if (continued) {
                await STM.clearSession(sessionId);
            }

            // 1. 短期记忆：连同落库缓存的 tokenCount 一并取出，预算器只读求和不重算
            const recent = await STM.safeGetRecentRounds(
                sessionId,
                SHORT_TERM_ROUNDS,
            );
            // 形状保持一致（role/content/msgId），只补时间戳与 tokenCount：
            // 后者让预算器只读求和、不必把每条历史重算一遍 token。
            const stmRounds: RawMessage[] = recent.map((m) => ({
                role: m.role,
                content: m.content,
                msgId: m.msgId,
                timestamp: m.timestamp,
                tokenCount: m.tokenCount,
            }));

            // 2. 记忆检索 → 选择（rrfScore 只活在内存里，绝不落库）
            let scoredLtm: MemorySearchResult[] = [];
            let selectedLtm: MemorySearchResult[] = [];
            try {
                const searchResult = await memorySearchService.search({
                    userId,
                    query,
                });
                const { selected, metadata } =
                    await memorySelectionService.select(searchResult.results);
                scoredLtm = searchResult.results;
                selectedLtm = selected;

                if (selected.length > 0) {
                    // 此处只报「选择层选出多少」，真正注入了多少由下文的计量账单给出
                    logger.info('会话记忆选择完成', {
                        totalCandidates: metadata.totalCandidates,
                        afterPercentile: metadata.afterPercentile,
                        afterDedup: metadata.afterDedup,
                        selected: selected.length,
                        memories: selected.map((i) => i.content),
                    });
                }
            } catch (error) {
                // 记忆是可选增强：检索/选择异常不得中断对话
                logger.warn('记忆注入失败，对话照常继续', { error });
            }

            // 3. 笔记 RAG 检索（降级在注入层内部，已 try/catch，此处再兜一层）
            let scoredRag: NoteRetrievalResult[] = [];
            try {
                scoredRag = await retrieveNotes({ userId, query });
            } catch (error) {
                logger.warn('笔记注入失败，对话照常继续', { error });
            }

            // 4. 预算装配：一次算清 system / STM / LTM / RAG 四块，
            //    逐级降级（L0→L1→L2a/b/c→L3）后给出最终上下文与计量账单。
            const startedAt = Date.now();
            const budgeted = budgeter.assembleContext({
                systemPrompt: '',
                userMessage: latestUserMsg,
                stmRounds,
                scoredLtm,
                selectedLtm,
                scoredRag,
            });

            finalMessages = budgeted.finalMessages;
            // 渲染用的是预算器**实际装入**的 LTM / RAG：提示词与账单同源，
            // 不会出现「账单记已裁空、prompt 里还留着记忆」的错位。
            systemPrompt = buildSystemPrompt(
                budgeted.systemPrompt,
                budgeted.keptLtm,
                budgeted.keptRag,
            );

            // W3 软闸：本步只观测真实分布，不做强制硬裁（阈值待实测校准）
            logBudgetBill({
                sessionId,
                mode: mode || 'chat',
                model: budgeter.model,
                bill: budgeted.bill,
                startedAt,
            });
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
        //
        // 工具名白名单：模型会幻觉出不存在的工具（如 read_file / edit）。未列在 chatTools
        // 里的名字一律丢弃——不下发 onToolCall、不执行、不落写模式历史，本轮降级为普通回复。
        const ALLOWED_TOOL_NAMES = new Set(
            chatTools.map((t) => t.function.name),
        );
        const splicedToolCalls: SplicedToolCall[] = [];
        const rawIsToolRound =
            finishReason === 'tool_calls' || toolCallAcc.size > 0;
        if (rawIsToolRound) {
            for (const [index, acc] of toolCallAcc) {
                const name = acc.name ?? '';
                if (!ALLOWED_TOOL_NAMES.has(name)) {
                    // 不反馈模型重生成（保持跨 HTTP ReAct loop 的上下文干净）
                    logger.warn('写作模式收到未授权工具名，已丢弃', {
                        traceId,
                        toolName: name,
                    });
                    continue;
                }
                const toolCall: SplicedToolCall = {
                    id: acc.id ?? `call_${index}`,
                    type: 'function',
                    function: {
                        name,
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
        }
        // 以"实际留下来的工具"为准判定工具轮：全是幻觉工具时 splicedToolCalls 为空，
        // 本轮即普通文本轮——不发 run_paused，落库走下方既有文本分支，不污染工具历史。
        const isToolRound = splicedToolCalls.length > 0;
        if (isToolRound) {
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

        // token 计数在写入侧算一次并缓存（STM 与 Mongo 两处共用同一数值，预算器只读求和）
        const userTokenCount = latestUserMsg
            ? countTokens(latestUserMsg.content as string)
            : 0;
        const assistantTokenCount = countTokens(assistantMsg.content);

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
                              tokenCount: userTokenCount,
                          },
                      ]
                    : []),
                {
                    role: 'assistant',
                    content: assistantMsg.content,
                    timestamp: now,
                    msgId: assistantMsg.msgId,
                    traceId,
                    tokenCount: assistantTokenCount,
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
                                  tokenCount: userTokenCount,
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
                        tokenCount: assistantTokenCount,
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

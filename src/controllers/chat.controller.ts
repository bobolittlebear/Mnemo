// src/controllers/chat.controller.ts
import crypto from 'crypto';
import { Request, Response } from 'express';
import { createLogger } from '@/lib/logger';
import redisClient from '@/lib/redis';
import ApiResponse from '@/utils/apiResponse';
import { SESSION_TTL_SECONDS, UNKNOWN_ERROR } from '@/utils/constant';
import chatStreamService from '@/services/chat/chatStream.service';
import chatHistoryService from '@/services/chat/chatHistory.service';
import {
    assembleWriteContext,
    persistToolResult,
    countWriteRounds,
    ensureRunVisibleMessage,
} from '@/services/chat/writeModeContext.service';
import { generateMessageId } from '@/utils/tool';
import Session from '@/models/Session';
import type { RawMessage } from '@/types/chat';
import type { ToolResult } from '@/services/chat/writeModeContext.service';

const logger = createLogger('api');

/**
 * 轮数安全阀（M-C4，设计 §0.3.4 / §3.5）：一个 run 最多 3 个工具轮。
 * 失败触顶即收尾——失败重试只剩"锚点写错"一种确定性场景，超出 3 轮继续跑
 * 只会让模型重复同一处坏参数，白烧 token 且拖长用户等待。
 */
const MAX_WRITE_ROUNDS = 3;

/**
 * 阀门收尾的合成说明：既随 run_finished 下发（前端直接展示，不用自己编文案），
 * 也作为可见兜底消息落库（ensureRunVisibleMessage 的 message 覆盖），两处文案一致
 */
const WRITE_RUN_MAX_ROUNDS_MSG =
    '已在 3 轮内尝试但未能完成，run 已关闭。请检查笔记状态或手动调整。';

/** 设置 SSE 响应头 */
function setSSEHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
}

/** 从请求体解析消息列表 */
function parseMessages(body: Record<string, unknown>): RawMessage[] {
    const raw = Object.values(
        (body?.messages as Record<string, unknown>) || {},
    ) as RawMessage[];
    return Array.isArray(raw) ? raw : [];
}

/** 最新一条 user 消息增加 messageId */
function attachMessageId(messages: RawMessage[]): void {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg && !lastUserMsg.msgId) {
        lastUserMsg.msgId = generateMessageId();
    }
}
/** 最新一条 user 消息增加 timestamp */
function attachTimestamp(messages: RawMessage[]): void {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg && !lastUserMsg.timestamp) {
        lastUserMsg.timestamp = Date.now();
    }
}
/**
 * POST /stream/chat
 * 流式 AI 对话 — Controller 只做 HTTP 适配，业务逻辑归属 ChatStreamService
 */
const chat = async (req: Request, res: Response) => {
    const startTime = Date.now();
    const traceId = res.locals.traceId;

    try {
        const messages = parseMessages(req.body);
        attachMessageId(messages);
        attachTimestamp(messages);

        // 1. 身份与资源分离：userId 来自认证，sessionId 来自路由参数
        const uid = req.user.userId!;

        // 会话归属解析：新会话 vs 续聊
        let sid: string | undefined = req.meta.sessionId;
        let isNew = false;

        if (!sid) {
            // 新会话：生成 sessionId、绑定 Redis、写 Session 文档
            const firstUserMsg = messages.find((m) => m.role === 'user');
            const title = (firstUserMsg?.content || '').slice(0, 30);
            sid = crypto.randomBytes(16).toString('hex');
            await redisClient.set(`session:user:${sid}`, uid, {
                EX: SESSION_TTL_SECONDS,
            });
            await Session.create({
                userId: uid,
                sessionId: sid,
                title,
            });
            req.meta.sessionId = sid;
            isNew = true;
        } else {
            // 续聊：校验会话归属 + 状态
            const session = await Session.findOne({
                userId: uid,
                sessionId: sid,
            });
            if (!session) {
                res.status(404).json({ error: '会话不存在' });
                return;
            }
            if (session.status === 'deleted') {
                res.status(403).json({ error: '会话已销毁，不可复用' });
                return;
            }
            if (session.status === 'archived') {
                // 重激活：归档会话恢复为活跃
                Session.updateOne(
                    { sessionId: sid },
                    { $set: { status: 'active' } },
                ).catch(() => {});
            }
        }

        if (!messages.length) {
            logger.warn('无效的消息格式', { traceId, body: req.body });
            res.status(400).json({ error: 'Invalid messages format' });
            return;
        }

        // 1. 会话元数据
        const firstUserMsg = messages.find((m) => m.role === 'user');
        const title = (firstUserMsg?.content || '').slice(0, 30);

        // 上下文域统一来自中间件注入的 req.meta（M-C2）：Controller 不再临时读请求体，
        // 也不写入 RawMessage，避免污染消息数组（设计 D3）。
        // noteId 的 chat 模式隔离已由中间件保证，此处不再按 mode 判断。
        const mode = req.meta.mode ?? 'chat';
        const runId = req.meta.runId;
        const noteId = req.meta.noteId;

        // 写模式首轮装配（M-C3 补漏）：把笔记全文与写模式历史装配好再进 Service——
        // 否则首轮模型看不到当前笔记，锚点无从生成。装配结果里没有本轮用户指令
        // （工具轮才落库），故追加在历史之后。
        let writeContext:
            { messages: RawMessage[]; systemPrompt: string } | undefined;
        if (mode === 'write' && noteId && runId) {
            const ctx = await assembleWriteContext({
                sessionId: sid,
                userId: uid,
                noteId,
                runId,
                traceId,
            });
            writeContext = {
                messages: [...ctx.messages, ...messages],
                systemPrompt: ctx.systemPrompt,
            };
        }

        setSSEHeaders(res);

        // runId 回传客户端：工具轮续轮时由客户端带回，同一 run 多轮共享；
        // chat 模式为 undefined，JSON.stringify 自动省略该字段
        res.write(
            `event: meta\ndata: ${JSON.stringify({ sessionId: sid, title, runId })}\n\n`,
        );

        // 工具轮以 run_paused 为本轮流终态（取代 done），此处记录以便收尾时不再补 done
        let paused = false;

        // 委托 Service 执行流式对话，Controller 只负责将清洗后的 chunk 写入 SSE
        await chatStreamService.streamChat({
            sessionId: sid,
            userId: uid,
            messages,
            traceId,
            mode,
            runId,
            noteId,
            // 写模式预装配上下文：传入即跳过 Service 的 STM/记忆/笔记默认装配（M-C3）
            writeContext,
            onToolCall: (tc) => {
                res.write(
                    `event: tool_call\ndata: ${JSON.stringify({
                        runId,
                        toolCallId: tc.id,
                        tool: tc.function.name,
                        args: tc.function.arguments,
                    })}\n\n`,
                );
            },
            onRunPaused: () => {
                paused = true;
                res.write(
                    `event: run_paused\ndata: ${JSON.stringify({
                        runId,
                        reason: 'waiting_client_execution',
                    })}\n\n`,
                );
            },
            // signal: abortController.signal, // 后续加入心跳保护机制， 传递中断信号给 Service
            onChunk: (content) => {
                // 4. 显式声明 event: delta + JSON 格式统一
                res.write(
                    `event: delta\ndata: ${JSON.stringify({ content })}\n\n`,
                );
            },
        });

        // 流正常结束。工具轮已写过 run_paused（本轮流终态），不再补 done；
        // 普通回复轮行为不变。
        if (!paused) {
            // 写模式首轮即回复轮时，run 到此结束：补 run_finished（run 级终态），
            // 否则前端按设计 §3.4 一直禁用发送框等解锁信号，写 run 会卡死输入框
            if (mode === 'write' && runId) {
                res.write(
                    `event: run_finished\ndata: ${JSON.stringify({ runId })}\n\n`,
                );
            }
            res.write('event: done\ndata: [DONE]\n\n');
        }
        // 5. done 事件保持 JSON 格式
        // res.write('event: done\ndata: {}\n\n');·
        res.end();
    } catch (error: unknown) {
        logger.error('流式对话失败', {
            traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        } else {
            try {
                res.write(
                    `event: error\ndata: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`,
                );
            } catch (_) {
                // 连接可能已断开
            }
            res.end();
        }
    }
};

/** tool_result 的状态白名单（cancelled 亦可由客户端回传，后端悬挂兜底合成走同一形状） */
type ToolResultStatus = NonNullable<ToolResult['status']>;

function isToolResultStatus(value: unknown): value is ToolResultStatus {
    return value === 'applied' || value === 'failed' || value === 'cancelled';
}

/** 组装 tool_result 回执：可选字段有值才带，避免把 undefined 写进 Mixed 字段 */
function buildToolResult(
    body: Record<string, unknown>,
    status: ToolResultStatus,
): ToolResult {
    const result: ToolResult = { status };
    if (typeof body.docHash === 'string') result.docHash = body.docHash;
    if (typeof body.titleAfter === 'string') {
        result.titleAfter = body.titleAfter;
    }
    if (typeof body.error === 'string') result.error = body.error;
    return result;
}

/**
 * POST /stream/chat/tool-result
 * 客户端回传工具执行结果 → 落库 tool 消息 → 重装写模式上下文 → 内联续轮 SSE
 *
 * 只服务写模式：chat 模式没有工具轮。校验与落库都在写 SSE 头之前完成，
 * 失败时可干净地返回 JSON 而非半截 SSE 流。
 */
const handleToolResult = async (req: Request, res: Response) => {
    const startTime = Date.now();
    const traceId = res.locals.traceId;

    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const uid = req.user.userId!;
        const { sessionId, mode, noteId, runId } = req.meta;

        if (mode !== 'write') {
            res.status(400).json({ error: '仅写模式可用' });
            return;
        }
        const toolCallId =
            typeof body.toolCallId === 'string' ? body.toolCallId : '';
        if (!toolCallId) {
            res.status(400).json({ error: '缺少 toolCallId' });
            return;
        }
        if (!isToolResultStatus(body.status)) {
            res.status(400).json({ error: 'status 非法' });
            return;
        }
        if (!sessionId || !noteId || !runId) {
            // 中间件保证写模式三者齐备；缺失说明请求绕过了中间件，续轮无从装配与落库
            res.status(400).json({
                error: '写模式缺少 sessionId/noteId/runId',
            });
            return;
        }

        // 1. 回执先落库：续轮上下文必须含有本轮 tool 消息，模型据此判断修正还是收尾
        await persistToolResult({
            sessionId,
            userId: uid,
            noteId,
            runId,
            traceId,
            toolCallId,
            result: buildToolResult(body, body.status),
        });

        // 2. 轮数安全阀（设计 §0.3.4）：已完成轮数触顶且本次回执失败 → 不再消耗第 4 次 LLM，
        //    后端合成收尾说明并把 run 关闭。判据是「失败触顶」而非无条件封顶：
        //    成功轮（applied）说明模型仍在推进，不该被轮数打断。
        const rounds = await countWriteRounds({ sessionId, noteId, runId });
        if (rounds >= MAX_WRITE_ROUNDS && body.status === 'failed') {
            setSSEHeaders(res);
            res.write(
                `event: meta\ndata: ${JSON.stringify({ sessionId, runId })}\n\n`,
            );
            res.write(
                `event: run_finished\ndata: ${JSON.stringify({
                    runId,
                    reason: 'max_rounds_reached',
                    message: WRITE_RUN_MAX_ROUNDS_MSG,
                })}\n\n`,
            );

            await ensureRunVisibleMessage({
                sessionId,
                noteId,
                runId,
                traceId,
                message: WRITE_RUN_MAX_ROUNDS_MSG,
            }); // ← 加 message

            res.write('event: done\ndata: [DONE]\n\n');
            res.end();
            logger.warn('写模式 run 触发轮数安全阀，已收尾', {
                traceId,
                sessionId,
                noteId,
                runId,
                rounds,
                status: body.status,
                duration_ms: Date.now() - startTime,
            });
            return;
        }

        // 3. 重装上下文：每轮重取笔记全文（run 内 patch 持续改文档，锚点须基于最新全文）
        const writeContext = await assembleWriteContext({
            sessionId,
            userId: uid,
            noteId,
            runId,
            traceId,
        });

        setSSEHeaders(res);
        res.write(
            `event: meta\ndata: ${JSON.stringify({ sessionId, runId })}\n\n`,
        );

        // 工具轮以 run_paused 为本轮流终态（取代 done），此处记录以便收尾时不再补 done
        let paused = false;
        // 本轮产出的可见正文：回复轮的 Mongo 落库发生在 Service 的 setImmediate 里，
        // 收尾兜底若直接查库会撞上这个写入窗口（正常 run 被误判成"无可见消息"而补错文案），
        // 故用与 Service 落库判据完全一致的可见正文来判断（onChunk 收到的正是被累计的清洗后文本）
        let replyContent = '';

        // 4. 续轮：messages 传空——历史（含刚落库的 tool 消息）已全部在 writeContext 内
        await chatStreamService.streamChat({
            sessionId,
            userId: uid,
            messages: [],
            traceId,
            mode: 'write',
            runId,
            noteId,
            writeContext,
            onToolCall: (tc) => {
                res.write(
                    `event: tool_call\ndata: ${JSON.stringify({
                        runId,
                        toolCallId: tc.id,
                        tool: tc.function.name,
                        args: tc.function.arguments,
                    })}\n\n`,
                );
            },
            onRunPaused: () => {
                paused = true;
                res.write(
                    `event: run_paused\ndata: ${JSON.stringify({
                        runId,
                        reason: 'waiting_client_execution',
                    })}\n\n`,
                );
            },
            onChunk: (content) => {
                replyContent += content;
                res.write(
                    `event: delta\ndata: ${JSON.stringify({ content })}\n\n`,
                );
            },
        });

        if (!paused) {
            // 层2 兜底：本轮没产出可见正文（Service 侧同样跳过落库）时，run 结束前
            // 校验该 runId 下是否已有可见 assistant 消息，没有就补一条失败说明
            if (!replyContent.trim()) {
                await ensureRunVisibleMessage({
                    sessionId,
                    noteId,
                    runId,
                    traceId,
                });
            }
            // run 级终态：续轮走到回复轮即 run 结束，前端据此解锁（设计 §6.1）
            res.write(
                `event: run_finished\ndata: ${JSON.stringify({ runId })}\n\n`,
            );
            res.write('event: done\ndata: [DONE]\n\n');
        }
        res.end();
    } catch (error: unknown) {
        logger.error('工具结果续轮失败', {
            traceId,
            duration_ms: Date.now() - startTime,
            error,
        });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        } else {
            try {
                res.write(
                    `event: error\ndata: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`,
                );
            } catch (_) {
                // 连接可能已断开
            }
            res.end();
        }
    }
};

/**
 * POST /stream/session/end
 * 结束当前会话（仅清除 Redis STM）
 */
const endSession = async (req: Request, res: Response) => {
    try {
        const userId = req.user.userId!;
        const sessionId = req.meta.sessionId;

        if (!sessionId) {
            res.status(400).json(ApiResponse.error('缺少 sessionId'));
            return;
        }

        if (sessionId) {
            await chatHistoryService.endSession({
                sessionId,
                userId,
            });
        }
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
 * GET /stream/chat/history
 * 获取历史消息（游标分页）
 */
const getChatHistory = async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
        const sessionId = req.meta.sessionId;
        if (!sessionId) {
            res.status(400).json(ApiResponse.error('缺少 sessionId'));
            return;
        }
        const limit = Math.min(Number(req.query?.limit) || 20, 100);
        const beforeId = req.query?.before_id as string | undefined;

        const formattedMessages = await chatHistoryService.getHistory(
            sessionId,
            limit,
            beforeId,
        );
        res.json(ApiResponse.success(formattedMessages));
    } catch (error) {
        logger.error('获取聊天历史失败', {
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

/**
 * DELETE /stream/chat/history
 * 彻底清空当前用户的会话记录（Redis STM + MongoDB）
 */
const clearChatHistory = async (req: Request, res: Response) => {
    try {
        const sessionId = req.meta.sessionId;
        if (!sessionId) {
            res.status(400).json(ApiResponse.error('缺少 sessionId'));
            return;
        }
        const result = await chatHistoryService.clearAll({
            sessionId,
            userId: req.user.userId!,
        });
        res.json(ApiResponse.success(result));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export { chat, handleToolResult, endSession, getChatHistory, clearChatHistory };

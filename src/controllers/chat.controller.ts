// src/controllers/chat.controller.ts
import crypto from 'crypto';
import { Request, Response } from 'express';
import { createLogger } from '@/lib/logger';
import redisClient from '@/lib/redis';
import ApiResponse from '@/utils/apiResponse';
import { SESSION_TTL_SECONDS, UNKNOWN_ERROR } from '@/utils/constant';
import chatStreamService from '@/services/chat/chatStream.service';
import chatHistoryService from '@/services/chat/chatHistory.service';
import { generateMessageId } from '@/utils/tool';
import Session from '@/models/Session';
import type { RawMessage } from '@/types/chat';

const logger = createLogger('api');

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

        setSSEHeaders(res);

        // 1. 会话元数据
        const firstUserMsg = messages.find((m) => m.role === 'user');
        const title = (firstUserMsg?.content || '').slice(0, 30);
        res.write(
            `event: meta\ndata: ${JSON.stringify({ sessionId: sid, title })}\n\n`,
        );

        // 2. 记忆检索结果（LLM 响应前发送，让前端展示引用来源）
        // event: memory_hit
        // data: {"count":3,"snippets":[{"id":"mem_001","content":"...","score":0.92}]}

        // 3. 工具调用（Agent 执行动作时）
        // event: tool_call
        // data: {"name":"search_memory","arguments":{"query":"用户偏好"}}

        // 委托 Service 执行流式对话，Controller 只负责将清洗后的 chunk 写入 SSE
        await chatStreamService.streamChat({
            sessionId: sid,
            userId: uid,
            messages,
            traceId,
            // signal: abortController.signal, // 后续加入心跳保护机制， 传递中断信号给 Service
            onChunk: (content) => {
                // 4. 显式声明 event: delta + JSON 格式统一
                res.write(
                    `event: delta\ndata: ${JSON.stringify({ content })}\n\n`,
                );
            },
        });

        // 流正常结束
        res.write('event: done\ndata: [DONE]\n\n');
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

export { chat, endSession, getChatHistory, clearChatHistory };

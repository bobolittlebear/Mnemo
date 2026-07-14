// src/controllers/chat.controller.ts
import { Request, Response } from 'express';
import { createLogger } from '@/lib/logger';
import ApiResponse from '@/utils/apiResponse';
import { UNKNOWN_ERROR } from '@/utils/constant';
import chatStreamService from '@/services/chat/chatStream.service';
import chatHistoryService from '@/services/chat/chatHistory.service';
import { generateEmbeddings } from '@/lib/embedding';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const logger = createLogger('api');

/** 设置 SSE 响应头 */
function setSSEHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
}

/** 从请求体解析消息列表 */
function parseMessages(
    body: Record<string, unknown>,
): ChatCompletionMessageParam[] {
    const raw = Object.values(
        (body?.messages as Record<string, unknown>) || {},
    ) as ChatCompletionMessageParam[];
    return Array.isArray(raw) ? raw : [];
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
        if (!messages.length) {
            logger.warn('无效的消息格式', { traceId, body: req.body });
            res.status(400).json({ error: 'Invalid messages format' });
            return;
        }

        const memoryKey = req.user.memoryKey!;
        setSSEHeaders(res);

        // 委托 Service 执行流式对话，Controller 只负责将清洗后的 chunk 写入 SSE
        await chatStreamService.streamChat(
            memoryKey,
            messages,
            traceId,
            (content) => {
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
            },
        );

        // 流正常结束
        res.write('event: done\ndata: [DONE]\n\n');
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
        const memoryKey = req.cookies.memory_key;
        if (memoryKey) {
            await chatHistoryService.endSession(memoryKey);
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
        const memoryKey = req.user?.memoryKey!;
        const limit = Math.min(Number(req.query?.limit) || 20, 100);
        const beforeId = req.query?.before_id as string | undefined;

        const formattedMessages = await chatHistoryService.getHistory(
            memoryKey,
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
        const memoryKey = req.user.memoryKey!;
        const result = await chatHistoryService.clearAll(memoryKey);
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

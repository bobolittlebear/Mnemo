// src/controllers/chat.controller.ts
import { Request, Response } from 'express';
import { createStreamChat } from '../service/ai.service';
import logger from '../lib/logger';
import { StreamCleaner } from '@/util/streamCleaner';
import STM, { STMMessage } from '@/util/shortTermMemory';

// 配置：短期记忆要注入的最近轮数
const SHORT_TERM_ROUNDS = Number(process.env.STM_ROUNDS || 10);

export const handleStreamChat = async (req: Request, res: Response) => {
    // 为每个请求创建一个独立的清洗器实例
    const cleaner = new StreamCleaner();
    try {
        const rawMessages = Object.values(req.body?.messages || []);
        const messages = Array.isArray(rawMessages) ? rawMessages : [];

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
        }));
        const finalMessages = [
            ...systemInjected,
            messages[messages.length - 1],
        ];
        logger.info('Received chat request', finalMessages);

        // 3. 发起 AI 流请求
        const stream = (await createStreamChat(
            finalMessages,
        )) as unknown as AsyncIterable<any>;

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';

            if (content) {
                // 【关键步骤】调用清洗器
                const { cleaned, isDuplicate } = cleaner.clean(content);
                // 只有当清洗后有内容，且不是完全重复时，才发送给前端
                if (cleaned && !isDuplicate) {
                    res.write(
                        `data: ${JSON.stringify({ content: cleaned })}\n\n`,
                    );
                }
            }
        }

        // 4. 发送结束标记
        res.write('data: [DONE]\n\n');
        res.end();

        // 5. 异步保存本次会话消息到短期记忆（不阻塞主流程）
        (async () => {
            try {
                // 保存原始发送的消息（user -> assistant）
                STM.addMessages(memoryKey, messages).catch((e) => {
                    logger.warn('STM save error', e);
                });
            } catch (e) {
                logger.warn('STM save error', e);
            }
        })();
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

// 封装一个带超时的安全读取方法
async function safeGetRecentRounds(
    id: string,
    rounds: number,
    timeoutMs = 100,
): Promise<STMMessage[]> {
    return Promise.race([
        STM.getRecentRounds(id, rounds),
        new Promise<STMMessage[]>((resolve) =>
            setTimeout(() => resolve([]), timeoutMs),
        ),
    ]);
}

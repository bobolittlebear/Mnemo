// src/controllers/chat.controller.ts
import { Request, Response } from 'express';
import { createStreamChat } from '../service/ai.service';
import logger from '../lib/logger';
import { StreamCleaner } from '../util/streamCleaner';
import { MAX_CHECK_LENGTH } from '../util/constant';

export const handleStreamChat = async (req: Request, res: Response) => {
    // 为每个请求创建一个独立的清洗器实例
    const cleaner = new StreamCleaner();
    try {
        const messages = Object.values(req.body?.messages);
        logger.info('Received chat request', messages);

        if (!messages || !Array.isArray(messages)) {
            logger.error('Invalid messages format:', messages);
            return res.status(400).json({ error: 'Invalid messages format' });
        }

        // 1. 设置 SSE 响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // 关键：防止 Nginx 等反向代理缓冲流数据

        // 2. 获取流并添加类型断言
        const stream = (await createStreamChat(
            messages,
        )) as unknown as AsyncIterable<any>;

        // 【关键】维护一个缓冲区，用于检测重复
        // 在生产环境中，如果对话极长，建议只保留最近 500-1000 个字符以节省内存
        let lastTail = ''; // 维护上一个 Chunk 的尾部状态

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

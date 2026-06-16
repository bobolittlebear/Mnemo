// src/controllers/chat.controller.ts
import { Request, Response } from 'express';
import { createStreamChat } from '../service/ai.service';
import logger from '../lib/logger';

export const handleStreamChat = async (req: Request, res: Response) => {
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

        // 3. 遍历流并写入响应
        for await (const chunk of stream) {
            // OpenAI SDK 的流式块结构
            const content = chunk.choices?.[0]?.delta?.content || '';

            console.log('Stream Chunk:', content); // 调试输出
            if (content) {
                // SSE 格式：data: <JSON>\n\n
                // 建议将内容包装在 JSON 中，方便前端解析（特别是处理换行符时）
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
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

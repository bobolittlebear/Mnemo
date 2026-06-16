import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: process.env.AI_BASE_URL,
    apiKey: process.env.AI_API_KEY,
});

// 创建流式对话
export async function createStreamChat(messages: any[]) {
    return client.chat.completions.create({
        model: process.env.AI_MODEL || 'qwen3.7-plus',
        messages,
        stream: true,
        // @ts-ignore - 忽略类型检查，因为 enable_thinking 是非标准字段
        extra_body: {
            enable_thinking: true,
        },
        stream_options: {
            include_usage: true, // 在流式输出中包含使用情况统计
        },
    } as any);
}

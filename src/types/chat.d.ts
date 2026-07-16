import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
type Role = 'system' | 'user' | 'assistant' | 'tool' | string;

export interface RawMessage extends ChatCompletionMessageParam {
    id: string; // mongodb ObjectId
    msgId: string; // 'msg-'前缀 + uuid v7 id
    role: Role;
    content: string;
    timestamp: number;
    traceId?: string; // 请求的追踪标识
}

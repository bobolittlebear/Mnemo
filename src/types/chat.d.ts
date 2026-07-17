import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
type Role = 'system' | 'user' | 'assistant' | 'tool' | string;

/**会话中产生的消息, 暂存 redis 的短期记忆消息 */
export interface RawMessage extends ChatCompletionMessageParam {
    msgId: string; // 'msg-'前缀 + uuid v7 id
    role: Role;
    content: string;
    timestamp: number;
    traceId?: string; // 请求的追踪标识
}

/**存 mongodb 的历史消息 */
export interface HistoryMessage extends Omit<RawMessage, 'timestamp'> {
    id: string; // mongodb ObjectId 自动生成
    timestamp: string; // getHistory处理成字符串
}

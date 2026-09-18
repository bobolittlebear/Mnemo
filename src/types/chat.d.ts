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

/**
 * 历史消息里的工具调用（读出侧形状，对齐存储侧 ChatMessage.toolCalls 元素）
 * arguments 透传存储原值：结构化对象，或 safeParseToolArgs 解析失败时回退的原串
 * （前端执行器直接消费，读出侧不二次 parse）
 */
export interface HistoryToolCall {
    id: string; // 模型生成的 toolCallId，tool 消息的 toolCallId 引用它
    name: string;
    arguments: Record<string, unknown> | string;
}

/**存 mongodb 的历史消息 */
export interface HistoryMessage extends Omit<RawMessage, 'timestamp'> {
    id: string; // mongodb ObjectId 自动生成
    timestamp: string; // getHistory处理成字符串

    // ── 工具调用链路扩容（M-D1）──
    // 全部可选：chat 消息（或工具调用之前的存量消息）不含这些字段，映射出来是 undefined，
    // 前端按 undefined 走普通气泡分支。前端据 runId 把同一 run 的多轮聚合成「run 气泡」。
    mode?: 'chat' | 'write'; // 消息归属的上下文域
    noteId?: string; // 写模式的笔记作用域
    runId?: string; // 一个 run 的多轮次共享
    toolCalls?: HistoryToolCall[]; // 挂在 assistant 消息上
    toolCallId?: string; // 挂在 tool 消息上，引用 assistant.toolCalls[].id
    /** 工具执行回执。整对象透传（含 docHash/titleAfter 等机器层字段，供前端对账展示） */
    result?: {
        status: 'applied' | 'failed' | 'cancelled'; // cancelled = 悬挂兜底合成
        docHash?: string;
        titleAfter?: string;
        error?: string; // 失败原因（含兜底合成的取消原因，无独立 reason 字段）
    };
}

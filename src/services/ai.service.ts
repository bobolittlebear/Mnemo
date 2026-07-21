// src/services/ai.service.ts
import { getAIApi } from './core/llm';
import { AI_CONFIG, AI_MODEL } from '@/utils/config';
import type { RawMessage } from '@/types/chat';

// ==================== 类型定义 ====================

export interface StreamChatOptions {
    /** 是否启用思考模式（Qwen 特有） */
    enableThinking?: boolean;
    /** 温度参数，控制随机性 (0-2) */
    temperature?: number;
    /** 最大输出 token 数 */
    maxTokens?: number;
    /** 系统提示词 */
    systemPrompt?: string;
    /** 消息元数据 */
    metadata?: {
        /** 请求的追踪标识字段 */
        traceId?: string;
        /** 消息唯一ID */
        msgId?: string;
    };
}
export interface UsageInfo {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

// ==================== 核心方法 ====================
/**
 * 创建流式对话
 * @param messages - 对话消息列表
 * @param options - 可选配置
 * @returns OpenAI 流式响应对象
 */
export async function createStreamChat(
    messages: Partial<RawMessage>[],
    options: StreamChatOptions = {},
) {
    const {
        enableThinking = true,
        temperature,
        maxTokens,
        systemPrompt,
        metadata,
    } = options;

    // 如果提供了系统提示词，自动前置
    const finalMessages: Partial<RawMessage>[] = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages;

    const ai = getAIApi();

    return ai.chat.completions.create({
        model: AI_MODEL,
        messages: finalMessages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        metadata,
        // @ts-ignore - enable_thinking 是 Qwen 等非标准扩展字段
        extra_body: {
            enable_thinking: enableThinking,
        },
        stream_options: {
            include_usage: true,
        },
    } as any);
}

/**
 * 创建非流式对话（普通请求）
 * @param messages - 对话消息列表
 * @param options - 可选配置
 * @returns 完整的对话响应内容
 */
export async function createChat(
    messages: Partial<RawMessage>[],
    options: StreamChatOptions = {},
): Promise<{ content: string; usage?: UsageInfo }> {
    const {
        enableThinking = true,
        temperature,
        maxTokens,
        systemPrompt,
        metadata,
    } = options;

    const finalMessages: Partial<RawMessage>[] = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages;

    const ai = getAIApi({
        timeout: AI_CONFIG.DEFAULT_REQUEST_TIMEOUT,
    });

    const response = await ai.chat.completions.create({
        model: AI_MODEL,
        messages: finalMessages,
        temperature,
        max_tokens: maxTokens,
        metadata,
        // @ts-ignore
        extra_body: {
            enable_thinking: enableThinking,
        },
    } as any);

    const choice = response.choices?.[0];
    const usage = response.usage;

    return {
        content: choice?.message?.content ?? '',
        ...(usage
            ? {
                  usage: {
                      promptTokens: usage.prompt_tokens,
                      completionTokens: usage.completion_tokens,
                      totalTokens: usage.total_tokens,
                  },
              }
            : {}),
    };
}
/**
 * 从流式响应中提取 usage 信息
 * 注意：usage 通常在流的最后一个 chunk 中返回
 * @param chunk - 流式响应的单个 chunk
 */
export function extractUsageFromChunk(chunk: any): UsageInfo | null {
    if (chunk?.usage) {
        return {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
        };
    }
    return null;
}

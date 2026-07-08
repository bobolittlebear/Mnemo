// src/service/core/config.ts
import { AI_CONFIG } from '@/util/config';
import OpenAI from 'openai';

export interface AIApiOptions {
    timeout?: number;
    maxRetries?: number;
}

/**
 * 获取 OpenAI 兼容客户端实例
 * @param options - 可选的超时与重试配置
 */
export const getAIApi = (options?: AIApiOptions): OpenAI => {
    const baseUrl = process.env.AI_BASE_URL;
    const apiKey = process.env.AI_API_KEY;

    if (!baseUrl || !apiKey) {
        throw new Error(
            '[AI Service] ❌ AI_BASE_URL and AI_API_KEY are required. ' +
                'Please check your environment variables.',
        );
    }

    return new OpenAI({
        baseURL: baseUrl,
        apiKey,
        timeout: options?.timeout ?? AI_CONFIG.DEFAULT_TIMEOUT,
        maxRetries: options?.maxRetries ?? AI_CONFIG.DEFAULT_MAX_RETRIES,
    });
};

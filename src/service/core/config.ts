// src/service/core/config.ts
import OpenAI from 'openai';

export const getAIApi = (props?: { timeout?: number; maxRetries?: number }) => {
    const baseUrl = process.env.AI_BASE_URL;
    const apiKey = process.env.AI_API_KEY;

    if (!baseUrl || !apiKey) {
        console.warn(
            '[AI Service] ⚠️ AI_BASE_URL or AI_API_KEY is not configured. AI features may fail.',
        );
    }
    const { timeout, maxRetries } = props || {};

    return new OpenAI({
        baseURL: baseUrl,
        apiKey,
        timeout,
        maxRetries,
    });
};

export const AI_MODEL = (() => process.env.AI_MODEL || 'qwen3.7-plus')();

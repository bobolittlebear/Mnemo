// src/lib/embedding.ts
import { getAIApi } from '@/service/core/llm';
import { createLogger } from './logger';
import {
    EMBEDDING_MODEL,
    EMBEDDING_CONFIG,
    EMBEDDING_DIMENSIONS,
} from '@/util/config';
import pLimit from 'p-limit';

const logger = createLogger('rag');

/**
 * 带指数退避的重试包装器
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    retries = EMBEDDING_CONFIG.DEFAULT_MAX_RETRIES,
): Promise<T> {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error: any) {
            const isRateLimit = error?.status === 429;
            const isTimeout =
                error?.code === 'ETIMEDOUT' || error?.status >= 500;
            const isRetryable = isRateLimit || isTimeout;

            if (!isRetryable || i === retries - 1) throw error;

            const delay = Math.min(1000 * Math.pow(2, i), 10000); // 1s → 2s → 4s, max 10s
            logger.warn('Embedding API retrying due to error', {
                error,
                retryAttempt: i + 1,
                maxRetries: retries,
                delay,
            });
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw new Error('Unreachable');
}

/** 向量化封装 */
// TODO 先分块，再向量化
/**
 * ✅ P0-2.2 核心修复：批量生成 Embeddings
 * - 修复了原 for 循环未收集结果的 Bug
 * - 支持自动分批 + 并发控制
 * - 内置指数退避重试
 */
export async function generateEmbeddings(props: { input: string | string[] }) {
    const { input } = props || {};
    if (!input) return [];
    const formatInput = (Array.isArray(input) ? input : [input])
        .map((item) => item.trim())
        .filter(Boolean);
    // openai 的 embedding api 对于空字符串会返回 400 错误，所以这里直接过滤掉
    if (!formatInput.length) {
        console.warn('generateEmbeddings: 所有输入均为空字符串');
        return [];
    }

    // 按 MAX_BATCH_SIZE 分批
    const batches: string[][] = [];
    for (
        let i = 0;
        i < formatInput.length;
        i += EMBEDDING_CONFIG.DEFAULT_MAX_BATCH_SIZE
    ) {
        batches.push(
            formatInput.slice(i, i + EMBEDDING_CONFIG.DEFAULT_MAX_BATCH_SIZE),
        );
    }

    const ai = getAIApi();
    // 使用 p-limit 并发执行并收集所有批次结果
    const limit = pLimit(EMBEDDING_CONFIG.DEFAULT_CONCURRENCY);
    const batchResults = await Promise.all(
        batches.map((batch) =>
            limit(async () => {
                const response = await withRetry(() =>
                    ai.embeddings.create({
                        model: EMBEDDING_MODEL,
                        input: batch,
                        dimensions: EMBEDDING_DIMENSIONS,
                    }),
                );
                // 之前这里没有 return/push，现在正确返回
                return response.data
                    .sort((a, b) => a.index - b.index) // 确保顺序与输入一致
                    .map((d) => d.embedding);
            }),
        ),
    );

    // 展平所有批次结果为单一向量数组
    const allEmbeddings: number[][] = batchResults.flat();

    logger.info(
        `Generated ${allEmbeddings.length} embeddings in ${batches.length} batch(es)`,
        {
            inputLength: formatInput.length,
            batchCount: batches.length,
            model: EMBEDDING_MODEL,
        },
    );
    return allEmbeddings;
}

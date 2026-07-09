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

/**
 * 文本向量化
 * - 批量生成 Embeddings
 * - 支持自动分批 + 并发控制
 * - 内置指数退避重试
 */
export async function generateEmbeddings(input: string | string[]) {
    if (!input) return [];
    const formatInput = (Array.isArray(input) ? input : [input])
        .map((item) => item.trim())
        .filter(Boolean);
    // openai 的 embedding api 对于空字符串会返回 400 错误，所以这里直接过滤掉
    if (!formatInput.length) {
        console.warn('generateEmbeddings: 所有输入均为空字符串');
        return [];
    }

    // TODO：RAG阶段需要实现按层级分隔符尝试切分，最大程度保持语义完整
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
    // 并发执行并收集所有批次结果
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

                const normalization = false;

                return response.data
                    .sort((a, b) => a.index - b.index) // 确保顺序与输入一致
                    .map((d) => {
                        return formatVectors(
                            decodeEmbedding(d.embedding),
                            normalization,
                        );
                    });
            }),
        ),
    );

    // 展平所有批次结果为单一向量数组
    const allEmbeddings: number[][] = batchResults.flat();
    return allEmbeddings;
}

/**
 * 单条快捷方法（内部复用批量管道）
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const [embedding] = await generateEmbeddings([text]);
    if (!embedding) throw new Error(`Failed to generate embedding`);
    return embedding;
}
// 放在worker中计算token，不阻塞主线程
export const countPromptTokens = (prompt?: string) => {
    // TODO token计算逻辑
    return prompt?.length ?? 0;
};

/**
 * 将向量嵌入（Embedding）统一转换为 JavaScript 原生的数字数组格式。
 * 解决 AI/LLM 应用中常见的“向量数据传输与内存表示不一致”
 * @param embedding
 * @returns
 */
export function decodeEmbedding(embedding: number[] | string): number[] {
    // 防御性编程, 防止api返回base64编码
    if (typeof embedding === 'string') {
        // base64-encoded IEEE 754 little-endian float32 array
        const buf = Buffer.from(embedding, 'base64');
        const floats = new Float32Array(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength / 4,
        );
        return Array.from(floats);
    }
    return embedding;
}

/**
 * 向量化数据处理：降维截断、零填充补全、按需归一化、
 * @param vector
 * @param normalization
 * @returns
 */
export function formatVectors(vector: number[], normalization = false) {
    // 已归一化的 OpenAI 数据，设为 false;
    // 未归一化的本地模型数据，或需要优化数据库检索性能时，设为 true 以保证数据规范和计算效率
    function normalizationVector(vector: number[]) {
        // Calculate the Euclidean norm (L2 norm)
        const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
        if (norm === 0) {
            return vector;
        }
        // Normalize the vector by dividing each component by the norm
        return vector.map((val) => val / norm);
    }

    const dimension = EMBEDDING_CONFIG.DEFAULT_EMBEDDING_DIMENSIONS;
    // 超过上限，截断，并强制归一化
    if (vector.length > dimension) {
        logger.warn(
            `Embedding vector dimension exceeded, truncating to ${dimension}`,
            {
                vectorLength: vector.length,
                limit: dimension,
            },
        );
        return normalizationVector(vector.slice(0, dimension));
    } else if (vector.length < dimension) {
        const vectorLen = vector.length;

        const zeroVector = new Array(dimension - vectorLen).fill(0);

        vector = vector.concat(zeroVector);
    }

    if (normalization) {
        return normalizationVector(vector);
    }

    return vector;
}

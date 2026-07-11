// src/lib/embedding.ts
import { getAIApi } from '@/services/core/llm';
import { createLogger } from './logger';
import {
    EMBEDDING_MODEL,
    EMBEDDING_CONFIG,
    EMBEDDING_DIMENSIONS,
} from '@/utils/config';
import pLimit from 'p-limit';
import { withRetry } from './retry';
import { truncateByTokens, countTokens } from '@/utils/tokenizer';

const logger = createLogger('rag');

/**
 * 文本向量化
 * - 批量生成 Embeddings
 * - 支持自动分批 + 并发控制
 * - 内置指数退避重试
 */
export async function generateEmbeddings(
    input: string | string[],
): Promise<{ totalTokens: number; embeddings: number[][] }> {
    if (!input) return { totalTokens: 0, embeddings: [] };
    const formatInput = (Array.isArray(input) ? input : [input])
        .map((item) => item.trim())
        .filter(Boolean)
        .map((text) => truncateByTokens(text, EMBEDDING_CONFIG.MAX_TOKENS));

    // openai 的 embedding api 对于空字符串会返回 400 错误，所以这里直接过滤掉
    if (!formatInput.length) {
        console.warn('generateEmbeddings: 所有输入均为空字符串');
        return { totalTokens: 0, embeddings: [] };
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
    let totalTokens = 0;
    const batchResults = await Promise.all(
        batches.map((batch) =>
            limit(async () => {
                const response = await withRetry(
                    () =>
                        ai.embeddings.create({
                            model: EMBEDDING_MODEL,
                            input: batch,
                            dimensions: EMBEDDING_DIMENSIONS,
                        }),
                    {
                        attempts: EMBEDDING_CONFIG.DEFAULT_MAX_RETRIES,
                        logger,
                    },
                );

                const normalization = false;

                if (response.usage?.total_tokens) {
                    totalTokens += response.usage?.total_tokens;
                } else {
                    const tokens = await Promise.all(
                        batch.map((item) => countPromptTokens(item)),
                    );
                    totalTokens += tokens.reduce((sum, item) => sum + item, 0);
                }

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
    return { totalTokens, embeddings: allEmbeddings };
}

/**
 * 单条快捷方法（内部复用批量管道）
 */
export async function generateEmbedding(
    text: string,
): Promise<{ totalTokens: number; embeddings: number[][] }> {
    const { totalTokens, embeddings } = await generateEmbeddings([text]);
    if (!embeddings) throw new Error(`Failed to generate embedding`);
    return { totalTokens, embeddings };
}

// 对于会话级记忆，同步调用 countTokens
// TODO: RAG文档Token计算放在worker中计算token，不阻塞主线程
export const countPromptTokens = (prompt?: string) => {
    if (!prompt) return 0;
    return countTokens(prompt);
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

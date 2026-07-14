// src/services/memory/memorySearch.service.ts

import { MemoryFact } from '@/models/MemoryFact';
import { generateEmbedding } from '@/lib/embedding';
import { createLogger } from '@/lib/logger';
import { EMBEDDING_DIMENSIONS } from '@/utils/config';
import type {
    MemorySearchBaseDoc,
    MemorySearchOptions,
    MemorySearchResult,
    MemorySearchResponse,
    RankedDoc,
} from '@/types/memory';
import mongoose from 'mongoose';
import { rrfFusion } from './rrf';

const logger = createLogger('ltm');

// ── 默认检索参数 ──────────────────────────────────────────────

const DEFAULT_SEARCH_CONFIG = {
    vectorTopK: 20, // 向量检索返回条数
    textTopK: 20, // 关键词检索返回条数
    numCandidates: 100, // $vectorSearch 候选集大小
    finalTopN: 10, // RRF 融合后最终返回条数
    rrfK: 60, // RRF 平滑因子
};

// ── 内部类型 ──────────────────────────────────────────────────

/** $vectorSearch 聚合结果文档 */
interface VectorSearchDoc extends MemorySearchBaseDoc {
    vectorScore: number;
}

/** $text 聚合结果文档 */
interface TextSearchDoc extends MemorySearchBaseDoc {
    textScore: number;
}

// ── 混合检索服务 ──────────────────────────────────────────────

class MemorySearchService {
    /**
     * 混合检索：向量 + 关键词并行，RRF 融合
     *
     * 流程：
     * 1. 对 query 生成 embedding
     * 2. 并行执行向量检索 + 关键词检索
     * 3. RRF(k=60) 融合两路结果
     * 4. 返回 Top-N
     *
     * 降级策略：
     * - embedding 生成失败 → 纯关键词检索
     * - 单管道检索失败 → 使用另一管道结果直接返回
     * - 双管道均失败 → 返回空结果
     */
    async search(options: MemorySearchOptions): Promise<MemorySearchResponse> {
        const {
            memoryKey,
            query,
            vectorTopK = DEFAULT_SEARCH_CONFIG.vectorTopK,
            textTopK = DEFAULT_SEARCH_CONFIG.textTopK,
            numCandidates = DEFAULT_SEARCH_CONFIG.numCandidates,
            finalTopN = DEFAULT_SEARCH_CONFIG.finalTopN,
            rrfK = DEFAULT_SEARCH_CONFIG.rrfK,
            notebookId,
            type,
        } = options;

        if (!query?.trim()) {
            return {
                results: [],
                vectorCount: 0,
                textCount: 0,
                degraded: false,
            };
        }

        const trimmedQuery = query.trim();

        // ── 1. 生成 query embedding ──
        let queryEmbedding: number[];
        try {
            const startTime = Date.now();
            const { embeddings } = await generateEmbedding(trimmedQuery);
            queryEmbedding = embeddings[0]!;
            logger.info('queryEmbedding', { trimmedQuery, queryEmbedding });

            // 防御：维度校验
            if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
                throw new Error(
                    `Embedding 维度不匹配: 期望 ${EMBEDDING_DIMENSIONS}, 实际 ${queryEmbedding.length}`,
                );
            }

            logger.info('Query embedding generated', {
                duration_ms: Date.now() - startTime,
            });
        } catch (error) {
            logger.error('Query embedding 生成失败，降级为关键词检索', {
                error,
            });
            return this.textOnlyFallback(
                memoryKey,
                trimmedQuery,
                textTopK,
                finalTopN,
                notebookId,
                type,
            );
        }

        // ── 2. 并行执行双路检索 ──
        const [vectorResult, textResult] = await Promise.allSettled([
            this.vectorSearch(
                memoryKey,
                queryEmbedding,
                vectorTopK,
                numCandidates,
                notebookId,
                type,
            ),
            this.textSearch(
                memoryKey,
                trimmedQuery,
                textTopK,
                notebookId,
                type,
            ),
        ]);

        const vectorDocs =
            vectorResult.status === 'fulfilled' ? vectorResult.value : [];
        const textDocs =
            textResult.status === 'fulfilled' ? textResult.value : [];

        // ── 3. 降级判定 ──
        const vectorFailed = vectorResult.status === 'rejected';
        const textFailed = textResult.status === 'rejected';

        if (vectorFailed) {
            logger.warn('向量检索失败，使用关键词检索结果', {
                error:
                    vectorResult.reason instanceof Error
                        ? vectorResult.reason.message
                        : String(vectorResult.reason),
            });
        }
        if (textFailed) {
            logger.warn('关键词检索失败，使用向量检索结果', {
                error:
                    textResult.reason instanceof Error
                        ? textResult.reason.message
                        : String(textResult.reason),
            });
        }

        const degraded = vectorFailed || textFailed;
        const degradedReason =
            vectorFailed && textFailed
                ? '双管道均失败'
                : vectorFailed
                  ? '向量检索失败'
                  : textFailed
                    ? '关键词检索失败'
                    : undefined;

        // 双管道都失败 → 返回空
        if (vectorFailed && textFailed) {
            logger.error('混合检索双管道均失败');
            return {
                results: [],
                vectorCount: 0,
                textCount: 0,
                degraded: true,
                degradedReason,
            };
        }

        // ── 4. RRF 融合 ──
        const fused = rrfFusion([vectorDocs, textDocs], rrfK, finalTopN);

        logger.info('混合检索完成', {
            vectorCount: vectorDocs.length,
            textCount: textDocs.length,
            fusedCount: fused.length,
            degraded,
        });

        return {
            results: fused,
            vectorCount: vectorDocs.length,
            textCount: textDocs.length,
            degraded,
            degradedReason,
        };
    }

    /**
     * 向量检索：$vectorSearch + memoryKey 过滤
     *
     * 依赖 Atlas Vector Search 索引 `autoembed_index`（cosine, 1536维）
     */
    private async vectorSearch(
        memoryKey: string,
        queryEmbedding: number[],
        topK: number,
        numCandidates: number,
        notebookId?: string,
        type?: string,
    ): Promise<RankedDoc[]> {
        // 构建 $vectorSearch filter
        const filter: Record<string, { $eq: string }> = {
            memoryKey: { $eq: memoryKey },
        };
        if (notebookId) filter.notebookId = { $eq: notebookId };
        if (type) filter.type = { $eq: type };

        const pipeline = [
            {
                $vectorSearch: {
                    index: 'autoembed_index',
                    path: 'embedding',
                    queryVector: queryEmbedding,
                    numCandidates,
                    limit: topK,
                    filter,
                },
            },
            {
                $addFields: {
                    vectorScore: { $meta: 'vectorSearchScore' },
                },
            },
            {
                $project: {
                    _id: 1,
                    content: 1,
                    memoryKey: 1,
                    confidence: 1,
                    category: 1,
                    type: 1,
                    notebookId: 1,
                    sourceMessageIds: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    vectorScore: 1,
                },
            },
        ] satisfies mongoose.PipelineStage[];

        const startTime = Date.now();
        const docs: VectorSearchDoc[] = await MemoryFact.aggregate(pipeline);
        logger.info('向量检索完成', {
            count: docs.length,
            duration_ms: Date.now() - startTime,
        });

        return docs.map((doc, index) => ({
            _id: doc._id.toString(),
            content: doc.content,
            memoryKey: doc.memoryKey,
            confidence: doc.confidence,
            category: doc.category,
            type: doc.type,
            notebookId: doc.notebookId,
            sourceMessageIds: doc.sourceMessageIds,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            rank: index + 1,
            rawScore: doc.vectorScore ?? 0,
        }));
    }

    /**
     * 关键词检索：$text + memoryKey 过滤
     *
     * 依赖 schema 定义的 `memory_content_text_index`（default_language: 'none'）
     */
    private async textSearch(
        memoryKey: string,
        query: string,
        topK: number,
        notebookId?: string,
        type?: string,
    ): Promise<RankedDoc[]> {
        // 构建 $match 条件
        const matchStage: Record<string, unknown> = {
            $text: { $search: query },
            memoryKey,
        };
        if (notebookId) matchStage.notebookId = notebookId;
        if (type) matchStage.type = type;

        const pipeline = [
            { $match: matchStage }, // 执行全文搜索查询
            { $addFields: { textScore: { $meta: 'textScore' } } }, // 提取 MongoDB 自动计算的文本相关性分数
            { $sort: { textScore: -1 } }, // 按 textScore 降序排列
            { $limit: topK },
            {
                $project: {
                    _id: 1,
                    content: 1,
                    memoryKey: 1,
                    confidence: 1,
                    category: 1,
                    type: 1,
                    notebookId: 1,
                    sourceMessageIds: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    textScore: 1,
                },
            },
        ] satisfies mongoose.PipelineStage[];

        const startTime = Date.now();
        const docs: TextSearchDoc[] = await MemoryFact.aggregate(pipeline);
        logger.info('关键词检索完成', {
            count: docs.length,
            duration_ms: Date.now() - startTime,
        });

        return docs.map((doc, index) => ({
            _id: doc._id.toString(),
            content: doc.content,
            memoryKey: doc.memoryKey,
            confidence: doc.confidence,
            category: doc.category,
            type: doc.type,
            notebookId: doc.notebookId,
            sourceMessageIds: doc.sourceMessageIds,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            rank: index + 1,
            rawScore: doc.textScore ?? 0,
        }));
    }

    /**
     * 纯关键词降级路径（embedding 生成失败时使用）
     *
     * 直接取关键词检索 Top-N，不做 RRF 融合
     * rrfScore 设为文本原始得分，便于下游排序
     */
    private async textOnlyFallback(
        memoryKey: string,
        query: string,
        textTopK: number,
        finalTopN: number,
        notebookId?: string,
        type?: string,
    ): Promise<MemorySearchResponse> {
        try {
            const textDocs = await this.textSearch(
                memoryKey,
                query,
                textTopK,
                notebookId,
                type,
            );

            const results: MemorySearchResult[] = textDocs
                .slice(0, finalTopN)
                .map((doc) => ({
                    _id: doc._id,
                    content: doc.content,
                    memoryKey: doc.memoryKey,
                    confidence: doc.confidence,
                    category: doc.category,
                    type: doc.type,
                    notebookId: doc.notebookId,
                    sourceMessageIds: doc.sourceMessageIds,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt,
                    rrfScore: doc.rawScore,
                }));

            return {
                results,
                vectorCount: 0,
                textCount: textDocs.length,
                degraded: true,
                degradedReason: 'Embedding 生成失败，降级为关键词检索',
            };
        } catch (error) {
            logger.error('关键词降级检索也失败', { error });
            return {
                results: [],
                vectorCount: 0,
                textCount: 0,
                degraded: true,
                degradedReason: '所有检索管道均失败',
            };
        }
    }
}

export default new MemorySearchService();

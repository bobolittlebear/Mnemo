// src/services/memory/memorySelection.service.ts

/**
 * 记忆选择层 — 对 RRF 融合后的候选集做噪声截断 + 语义去重 + 硬上限兜底。
 *
 * 重要：该层在 LLM 请求关键路径上，可用性 > 去重质量。
 * - embedding 批量查询失败 → 跳过 B 管，不阻塞请求
 * - 部分文档缺 embedding → 直接保留，不参与去重比较
 * - 百分位截断后为空 → 取最高分一条兜底
 */

import { MemoryFact } from '@/models/MemoryFact';
import type {
    MemorySearchResult,
    MemorySelectionOutput,
    MemorySelectionMetadata,
    SelectionConfig,
    EmbeddingProvider,
} from '@/types/memory';
import { createLogger } from '@/lib/logger';
import {
    MEMORY_SELECTION_PERCENTILE,
    MEMORY_SELECTION_HARD_MAX,
    MEMORY_SELECTION_DEDUP_THRESHOLD,
    MEMORY_SELECTION_RECENCY_ENABLED,
    MEMORY_SELECTION_RECENCY_FLOOR,
    MEMORY_SELECTION_RECENCY_HALF_LIFE,
    MEMORY_SELECTION_MIN_VECTOR_SCORE,
} from '@/utils/config';
import mongoose from 'mongoose';

const logger = createLogger('ltm');

// ── 内部类型 ──────────────────────────────────────────────────

/** 带 embedding 的候选（去重用） */
interface EmbeddedCandidate {
    result: MemorySearchResult;
    embedding: number[];
}

// ── 百分位计算（线性插值，与 NumPy 兼容） ─────────────────────

/**
 * 计算给定数组在百分位 p 处的值（线性插值法）。
 *
 * 公式：index = p * (n - 1)，lower = floor(index)，upper = ceil(index)，
 *       value = sorted[lower] + fraction * (sorted[upper] - sorted[lower])
 *
 * @param sorted 已升序排序的数值数组
 * @param p 百分位（0-1）
 */
function linearPercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0]!;

    const index = p * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) return sorted[lower]!;

    const fraction = index - lower;
    return sorted[lower]! + fraction * (sorted[upper]! - sorted[lower]!);
}

// ── 余弦相似度 ────────────────────────────────────────────────

/**
 * 计算两个等长向量的余弦相似度。
 * Embedding 模型把文本映射为高维向量后，语义相近的文本 → 向量方向接近 → 余弦值趋近 1。
 * @returns cos(θ) ∈ [-1, 1]，值越接近 1 表示越相似
 */
function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0; // 分子：a·b 的点积累加
    let normA = 0; // |a|² 的累加（还没开根号）
    let normB = 0; // |b|² 的累加
    const len = a.length;

    for (let i = 0; i < len; i++) {
        const ai = a[i]!;
        const bi = b[i]!;
        dot += ai * bi; // 对应维度相乘再累加 → Σ(aᵢbᵢ)
        normA += ai * ai; // Σ(aᵢ²)
        normB += bi * bi; // Σ(bᵢ²)
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB); // |a| × |b|
    if (denom === 0) return 0; // cos(θ)
    return dot / denom;
}

// ── 默认 EmbeddingProvider ────────────────────────────────────

/**
 * 基于 MemoryFact 集合的默认 embedding 批量查询实现。
 *
 * 内聚在本文件，不另建 Provider 文件。
 */
function createDefaultEmbeddingProvider(): EmbeddingProvider {
    return {
        async batchGet(ids: string[]): Promise<Map<string, number[] | null>> {
            const map = new Map<string, number[] | null>();

            if (ids.length === 0) return map;

            // 将字符串 ID 转为 ObjectId 以便 Mongoose 查询
            const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));

            const docs = await MemoryFact.find({ _id: { $in: objectIds } })
                .select({ embedding: 1 })
                .lean();

            // 构建 id → embedding 映射
            const foundIds = new Set<string>();
            for (const doc of docs) {
                const idStr = doc._id.toString();
                foundIds.add(idStr);
                map.set(idStr, doc.embedding ?? null);
            }

            // 未找到的文档标记为 null
            for (const id of ids) {
                if (!foundIds.has(id)) {
                    map.set(id, null);
                }
            }

            return map;
        },
    };
}

// ── 记忆选择服务 ──────────────────────────────────────────────

class MemorySelectionService {
    private readonly embeddingProvider: EmbeddingProvider;

    /**
     * @param embeddingProvider 可选 DI 注入，默认走 MemoryFact 批量查询
     */
    constructor(embeddingProvider?: EmbeddingProvider) {
        this.embeddingProvider =
            embeddingProvider ?? createDefaultEmbeddingProvider();
    }

    /**
     * 对候选记忆集执行选择管线：百分位截断 → 语义去重 → 硬上限兜底。
     *
     * @param candidates RRF 融合后的候选记忆列表
     * @param config    可选配置覆盖常量默认值
     * @returns 选择结果 + 元数据
     */
    async select(
        candidates: MemorySearchResult[],
        config?: Partial<SelectionConfig>,
    ): Promise<MemorySelectionOutput> {
        const startTime = Date.now();

        const percentile = config?.percentile ?? MEMORY_SELECTION_PERCENTILE;
        const hardMax = config?.hardMax ?? MEMORY_SELECTION_HARD_MAX;
        const dedupThreshold =
            config?.dedupThreshold ?? MEMORY_SELECTION_DEDUP_THRESHOLD;
        const recencyEnabled =
            config?.recencyEnabled ?? MEMORY_SELECTION_RECENCY_ENABLED;
        const recencyFloor =
            config?.recencyFloor ?? MEMORY_SELECTION_RECENCY_FLOOR;
        const recencyHalfLife =
            config?.recencyHalfLife ?? MEMORY_SELECTION_RECENCY_HALF_LIFE;
        const minVectorScore =
            config?.minVectorScore ?? MEMORY_SELECTION_MIN_VECTOR_SCORE;

        // ── A0 向量分数绝对地板：候选集全部不相关但百分位掐不掉的均匀噪声 → 直接返回空 ──
        if (candidates.length > 0) {
            const vectorScores = candidates
                .map((c) => c.vectorScore)
                .filter((s): s is number => s !== undefined);
            // 仅当存在 vectorScore 时才触发地板（纯 BM25 降级跳过）
            if (vectorScores.length > 0) {
                const maxVectorScore = Math.max(...vectorScores);
                if (maxVectorScore < minVectorScore) {
                    const selectionLatencyMs = Date.now() - startTime;
                    logger.info('记忆选择完成（A0 vectorScore 地板触发，全部丢弃）', {
                        totalCandidates: candidates.length,
                        maxVectorScore,
                        minVectorScore,
                        selectionLatencyMs,
                    });
                    return {
                        selected: [],
                        metadata: {
                            totalCandidates: candidates.length,
                            percentileThreshold: NaN,
                            afterPercentile: 0,
                            afterDedup: 0,
                            hardMaxApplied: false,
                            hardMaxDropped: 0,
                            embeddingMissing: 0,
                            dedupSkipped: false,
                            selectionLatencyMs,
                            droppedByDedup: [],
                        },
                    };
                }
            }
        }

        // ── Pipeline A: 噪声兜底（百分位截断） ──
        const afterA = this.applyPercentileCutoff(candidates, percentile);

        // ── Pipeline B: 语义去重 ──
        const afterB = await this.applySemanticDedup(
            afterA.results,
            dedupThreshold,
        );

        // ── Pipeline C: 时效性提权（骨架，当前 RECENCY_ENABLED = false） ──
        let selected = afterB.results;
        if (recencyEnabled) {
            selected = this.applyRecencyBoost(
                selected,
                recencyFloor,
                recencyHalfLife,
            );
        }

        // ── 硬上限兜底 ──
        let hardMaxApplied = false;
        let hardMaxDropped = 0;
        if (selected.length > hardMax) {
            hardMaxDropped = selected.length - hardMax;
            hardMaxApplied = true;
            selected = selected
                .sort((a, b) => b.rrfScore - a.rrfScore)
                .slice(0, hardMax);
        }

        const selectionLatencyMs = Date.now() - startTime;

        logger.info('记忆选择完成', {
            totalCandidates: candidates.length,
            afterPercentile: afterA.results.length,
            afterDedup: afterB.results.length,
            afterHardMax: selected.length,
            hardMaxApplied,
            dedupSkipped: afterB.dedupSkipped,
            selectionLatencyMs,
        });

        const metadata: MemorySelectionMetadata = {
            totalCandidates: candidates.length,
            percentileThreshold: afterA.threshold,
            afterPercentile: afterA.results.length,
            afterDedup: afterB.results.length,
            hardMaxApplied,
            hardMaxDropped,
            embeddingMissing: afterB.embeddingMissing,
            dedupSkipped: afterB.dedupSkipped,
            selectionLatencyMs,
            droppedByDedup: afterB.droppedByDedup,
            dedupClusters: afterB.dedupClusters,
        };

        return { selected, metadata };
    }

    // ── Pipeline A 内部实现 ──────────────────────────────────

    /**
     * 百分位截断：保留 rrfScore >= P-th 百分位的候选。
     *
     * 空集兜底：过滤后为空时取 rrfScore 最高的一条。
     */
    private applyPercentileCutoff(
        candidates: MemorySearchResult[],
        percentile: number,
    ): { results: MemorySearchResult[]; threshold: number } {
        if (candidates.length === 0) {
            return { results: [], threshold: NaN };
        }

        // 按 rrfScore 升序排序，计算百分位阈值
        const scores = candidates.map((c) => c.rrfScore).sort((a, b) => a - b);
        const threshold = linearPercentile(scores, percentile);

        const filtered = candidates.filter((c) => c.rrfScore >= threshold);

        // 空集兜底：过滤后为空，取 rrfScore 最高的一条
        if (filtered.length === 0) {
            const best = candidates.reduce((a, b) =>
                a.rrfScore >= b.rrfScore ? a : b,
            );
            logger.debug('百分位截断后为空，触发空集兜底', {
                threshold,
                bestScore: best.rrfScore,
            });
            return { results: [best], threshold };
        }

        logger.debug('百分位截断完成', {
            before: candidates.length,
            after: filtered.length,
            threshold,
        });

        return { results: filtered, threshold };
    }

    // ── Pipeline B 内部实现 ──────────────────────────────────

    /**
     * 语义去重：基于 embedding 余弦相似度做贪心去重。
     *
     * 降级保护：
     * - batchGet 整体抛异常 → 跳过去重，返回 A 管输出
     * - 部分文档缺 embedding → 直接保留，不参与去重比较
     *
     * 贪心策略：按 rrfScore 降序遍历 → 与已保留集比较 →
     * 重复时保留 content.length 更长者。
     */
    private async applySemanticDedup(
        candidates: MemorySearchResult[],
        threshold: number,
    ): Promise<{
        results: MemorySearchResult[];
        embeddingMissing: number;
        dedupSkipped: boolean;
        droppedByDedup: string[];
        dedupClusters?: string[][];
    }> {
        if (candidates.length <= 1) {
            return {
                results: candidates,
                embeddingMissing: 0,
                dedupSkipped: false,
                droppedByDedup: [],
            };
        }

        // 批量获取 embedding
        let embeddingMap: Map<string, number[] | null>;
        try {
            embeddingMap = await this.embeddingProvider.batchGet(
                candidates.map((c) => c._id),
            );
        } catch (error) {
            logger.warn('Embedding 批量查询失败，跳过语义去重', {
                error,
                candidateCount: candidates.length,
            });
            return {
                results: candidates,
                embeddingMissing: candidates.length,
                dedupSkipped: true,
                droppedByDedup: [],
            };
        }

        // 分离：有 embedding vs 无 embedding
        const embedded: EmbeddedCandidate[] = [];
        const missing: MemorySearchResult[] = [];
        let embeddingMissing = 0;

        for (const candidate of candidates) {
            const emb = embeddingMap.get(candidate._id);
            if (emb && emb.length > 0) {
                embedded.push({ result: candidate, embedding: emb });
            } else {
                missing.push(candidate);
                if (emb === null || emb === undefined || emb.length === 0) {
                    embeddingMissing++;
                }
            }
        }

        // 无 embedding 的候选全部直接保留，不参与去重
        if (embedded.length === 0) {
            return {
                results: candidates,
                embeddingMissing,
                dedupSkipped: false,
                droppedByDedup: [],
            };
        }

        // 按 rrfScore 降序排序
        embedded.sort((a, b) => b.result.rrfScore - a.result.rrfScore);

        // 贪心去重
        const kept: EmbeddedCandidate[] = [];
        const droppedByDedup: string[] = [];
        const clusters: string[][] = []; // 诊断用：记录去重簇

        for (const candidate of embedded) {
            let isDuplicate = false;
            let duplicateOf: EmbeddedCandidate | null = null;

            for (const k of kept) {
                const sim = cosineSimilarity(candidate.embedding, k.embedding);
                if (sim > threshold) {
                    isDuplicate = true;
                    duplicateOf = k;
                    break;
                }
            }

            if (isDuplicate && duplicateOf) {
                // 保留 content.length 更长的那条
                if (
                    candidate.result.content.length >
                    duplicateOf.result.content.length
                ) {
                    // 新候选更长 → 替换已保留集中较短者
                    const replaced = duplicateOf;
                    const idx = kept.indexOf(replaced);
                    if (idx !== -1) {
                        kept[idx] = candidate;
                    }
                    droppedByDedup.push(replaced.result.content);
                    // 记录去重簇
                    clusters.push([
                        replaced.result.content,
                        candidate.result.content,
                    ]);
                } else {
                    // 新候选更短或等长 → 丢弃新候选
                    droppedByDedup.push(candidate.result.content);
                    clusters.push([
                        candidate.result.content,
                        duplicateOf.result.content,
                    ]);
                }
            } else {
                kept.push(candidate);
            }
        }

        // 合并：已保留（有 embedding）+ 无 embedding 直接保留
        const results = [...kept.map((e) => e.result), ...missing].sort(
            (a, b) => b.rrfScore - a.rrfScore,
        );

        logger.debug('语义去重完成', {
            before: candidates.length,
            after: results.length,
            dropped: droppedByDedup.length,
            embeddingMissing,
        });

        return {
            results,
            embeddingMissing,
            dedupSkipped: false,
            droppedByDedup,
            dedupClusters: clusters.length > 0 ? clusters : undefined,
        };
    }

    // ── Pipeline C 骨架（推迟实现） ────────────────────────────

    /**
     * 时效性提权：按记忆的创建时间衰减权重。
     *
     * TODO: 待实现。
     * 修正后的公式：
     *   age_days = (now - result.createdAt) / (24 * 3600 * 1000)
     *   recencyWeight = recencyFloor + (1 - recencyFloor) * 0.5^(age_days / halfLifeDays)
     *   finalScore = rrfScore * recencyWeight
     *
     * 排序后返回。注意不要改变原数组的 rrfScore 字段 —— 只做排序键。
     *
     * @param results      待提权的候选集
     * @param recencyFloor 时效性地板系数
     * @param halfLifeDays 半衰期（天）
     */
    private applyRecencyBoost(
        results: MemorySearchResult[],
        recencyFloor: number,
        halfLifeDays: number,
    ): MemorySearchResult[] {
        // TODO: 待实现
        void recencyFloor;
        void halfLifeDays;
        return results;
    }
}

export default new MemorySelectionService();

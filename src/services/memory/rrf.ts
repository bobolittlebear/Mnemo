import { MemorySearchResult, RankedDoc } from '@/types/memory';

/**
 * Reciprocal Rank Fusion （RRF 融合函数）
 *
 * 公式：score(d) = Σ_{r∈R} 1/(k + rank_r(d))
 * - k: 平滑因子，值越大低排名结果影响越小
 * - rank_r(d): 文档 d 在第 r 路检索中的排名（1-based）
 *
 * 同一文档出现在两路时得分叠加；仅出现在单路时只计该路得分。
 */
export function rrfFusion(
    pipelines: RankedDoc[][],
    k: number,
    topN: number,
): MemorySearchResult[] {
    const scoreMap = new Map<
        string,
        { doc: MemorySearchResult; rrfScore: number }
    >();

    for (const pipeline of pipelines) {
        if (!pipeline || !Array.isArray(pipeline)) continue; // 跳过 null/undefined 等非法输入

        const seenInPipeline = new Set<string>(); // 同路去重

        for (const doc of pipeline) {
            // 同路去重
            if (seenInPipeline.has(doc._id)) continue;
            seenInPipeline.add(doc._id);

            const contribution = 1 / (k + doc.rank);
            const existing = scoreMap.get(doc._id);
            if (existing) {
                existing.rrfScore += contribution;
                existing.doc.rrfScore = existing.rrfScore;
            } else {
                scoreMap.set(doc._id, {
                    doc: {
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
                        rrfScore: contribution,
                    },
                    rrfScore: contribution,
                });
            }
        }
    }

    return Array.from(scoreMap.values())
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .slice(0, topN)
        .map((entry) => entry.doc);
}

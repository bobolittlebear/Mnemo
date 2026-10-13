// 笔记 RAG 召回评测 —— 纯指标计算（无外部依赖，可离线单测）
// 对应设计 .claude/design/note-rag-test.md §8

/** Recall@K：返回前 K 个结果中命中相关集合的比例；relevant 空返回 0 */
export function computeRecallAtK(
    relevantIds: string[],
    retrievedIds: string[],
    k: number,
): number {
    if (relevantIds.length === 0) return 0;
    const topK = retrievedIds.slice(0, Math.max(0, k));
    const topKSet = new Set(topK);
    const hit = relevantIds.filter((id) => topKSet.has(id)).length;
    return hit / relevantIds.length;
}

/** 宏平均：一组数值的算术平均；空数组返回 0 */
export function macroAvg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface ComplementCase {
    relevantIds: string[];
    vectorTop5: string[];
    bm25Top5: string[];
}

/**
 * BM25 互补性计数：在给定 case 中，统计「向量 top-5 未命中任何相关，但 BM25 top-5 命中至少一条相关」的条数。
 * 调用方需先按 type 过滤出 hard 类 query 再传入。
 */
export function bm25ComplementCount(cases: ComplementCase[]): number {
    let count = 0;
    for (const c of cases) {
        const vSet = new Set(c.vectorTop5);
        const bSet = new Set(c.bm25Top5);
        const vectorHit = c.relevantIds.some((id) => vSet.has(id));
        const bm25Hit = c.relevantIds.some((id) => bSet.has(id));
        if (!vectorHit && bm25Hit) count++;
    }
    return count;
}

/**
 * 提取阶段产出：尚未向量化的原始事实
 */
export interface RawFact {
    content: string;
    confidence: number;
    category?: string;
    sourceMessageIds: string[];
}

/**
 * 向量化后的事实
 */
export interface EmbeddedFact extends RawFact {
    embedding: number[];
    metadata?: Record<string, any>;
}

/**
 * 入库上下文元数据
 */
export interface IngestionContext {
    userId?: string;
    sessionId: string;
    notebookId?: string;
    type?: 'fact' | 'note_chunk' | 'media';
}

/**
 * 入库结果统计
 */
export interface IngestionResult {
    totalProcessed: number;
    inserted: number;
    updated: number;
    skipped: number;
}

// ── 混合检索类型 ──────────────────────────────────────────────

/**
 * 混合检索选项
 */
export interface MemorySearchOptions {
    /** 租户/会话级隔离键 */
    userId: string;
    /** 用户查询文本 */
    query: string;
    /** 向量检索返回条数（默认 20） */
    vectorTopK?: number;
    /** 关键词检索返回条数（默认 20） */
    textTopK?: number;
    /** $vectorSearch 候选集大小（默认 100） */
    numCandidates?: number;
    /** RRF 融合后最终返回条数（默认 10） */
    finalTopN?: number;
    /** RRF 平滑因子 k（默认 60） */
    rrfK?: number;
    /** 笔记本隔离（可选） */
    notebookId?: string;
    /** 记忆类型过滤（可选） */
    type?: 'fact' | 'note_chunk' | 'media';
}
/**
 * 基础检索结果文档
 */
export interface MemorySearchBaseDoc {
    _id: string;
    content: string;
    userId: string;
    confidence: number;
    category?: string;
    type: string;
    notebookId?: string;
    sourceMessageIds: string[];
    createdAt: Date;
    updatedAt: Date;
}

/**
 * 单路检索的带排名结果
 */
export interface RankedDoc extends MemorySearchBaseDoc {
    /** 排名（1-based） */
    rank: number;
    /** 单路原始得分 */
    rawScore: number;
}

/**
 * 检索结果条目
 */
export interface MemorySearchResult extends MemorySearchBaseDoc {
    /** RRF 融合得分 */
    rrfScore: number;
}

/**
 * 混合检索响应
 */
export interface MemorySearchResponse {
    results: MemorySearchResult[];
    /** 向量检索命中数 */
    vectorCount: number;
    /** 关键词检索命中数 */
    textCount: number;
    /** 是否发生降级（单管道失败） */
    degraded: boolean;
    degradedReason?: string;
}

// ── 记忆选择层类型 ──────────────────────────────────────────────

/**
 * 记忆选择层配置（可覆盖常量默认值）
 */
export interface SelectionConfig {
    /** 百分位阈值（0-1），低于此值的候选被截断 */
    percentile?: number;
    /** 百分位算法 */
    percentileAlgorithm?: 'linear';
    /** 小样本保护：候选数 ≤ 此值时跳过百分位截断 */
    percentileMinCount?: number;
    /** 硬上限：最终返回的最大条数 */
    hardMax?: number;
    /** 语义去重相似度阈值 */
    dedupThreshold?: number;
    /** 是否启用时效性提权 */
    recencyEnabled?: boolean;
    /** 时效性地板系数 */
    recencyFloor?: number;
    /** 时效性半衰期（天） */
    recencyHalfLife?: number;
}

/**
 * Embedding 批量查询接口（DI 注入，便于测试替换）
 */
export interface EmbeddingProvider {
    batchGet(ids: string[]): Promise<Map<string, number[] | null>>;
}

/**
 * 记忆选择层输出
 */
export interface MemorySelectionOutput {
    selected: MemorySearchResult[];
    metadata: MemorySelectionMetadata;
}

/**
 * 选择过程元数据（可观测性）
 */
export interface MemorySelectionMetadata {
    /** 输入候选总数 */
    totalCandidates: number;
    /** 百分位阈值（跳过时为 NaN） */
    percentileThreshold: number;
    /** 百分位截断后剩余数 */
    afterPercentile: number;
    /** 去重后剩余数 */
    afterDedup: number;
    /** 是否触发了硬上限截断 */
    hardMaxApplied: boolean;
    /** 硬上限截断丢弃数 */
    hardMaxDropped: number;
    /** 无 embedding 的候选数（直接保留） */
    embeddingMissing: number;
    /** 是否跳过了去重（embedding 查询失败） */
    dedupSkipped: boolean;
    /** 选择总耗时（ms） */
    selectionLatencyMs: number;
    /** 被去重丢弃的 content 摘要列表 */
    droppedByDedup: string[];
    /** 去重簇（可选，诊断用） */
    dedupClusters?: string[][];
}

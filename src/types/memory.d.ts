/**
 * 提取阶段产出：尚未向量化的原始事实
 */
export interface RawFact {
    content: string;
    confidence: number;
    category?: string;
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
    memoryKey: string;
    sourceMessageIds: string[];
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
    memoryKey: string;
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
    memoryKey: string;
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

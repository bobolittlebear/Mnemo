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

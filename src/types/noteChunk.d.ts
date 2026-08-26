export interface ChunkConfig {
    maxParentTokens: number;
    maxChildTokens: number;
    minChildTokens: number;
}
export interface ParentChunk {
    sectionPath: string[]; // 标题层级路径
    title: string; // 本 parent 所属章节标题
    content: string; // 完整章节文本
    contentHash: string;
    chunkIndex: number; // parents 数组内 0-based 顺序
}

export interface ChildChunk {
    sectionPath: string[];
    title: string;
    parentIndex: number; // parents 数组下标，S4 入库时映射为 parentId
    content: string;
    contentHash: string;
    chunkIndex: number; // 文档内全局顺序
}

export interface ChunkStats {
    parentCount: number;
    childCount: number;
    avgChildTokens: number;
    maxChildTokens: number;
    minChildTokens: number;
    forcedSplitCount: number; // 被强制切分的超长单元数
}

export interface ChunkResult {
    parents: ParentChunk[];
    children: ChildChunk[];
    stats: ChunkStats;
}

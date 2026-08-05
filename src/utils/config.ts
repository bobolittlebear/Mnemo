/** AI 服务配置常量，集中管理避免魔法字符串 */
export const AI_CONFIG = {
    DEFAULT_MODEL: 'qwen3.7-plus',
    DEFAULT_STREAM_TIMEOUT: 60_000, // 默认超时和流式响应相同
    DEFAULT_REQUEST_TIMEOUT: 120_000, // 非流式响应超时
    DEFAULT_MAX_RETRIES: 2, // 重试次数
} as const;

/** 对话/生成模型名称 */
export const AI_MODEL: string = process.env.AI_MODEL || AI_CONFIG.DEFAULT_MODEL;

export const EMBEDDING_CONFIG = {
    DEFAULT_EMBEDDING: 'text-embedding-v4',
    DEFAULT_EMBEDDING_DIMENSIONS: 1536, // 1024或1535。text-embedding-v4 支持64~2048维用户自定义向量维度。
    DEFAULT_MAX_BATCH_SIZE: 10, // openai最大限制100, qwen DashScope最大限制10, 这里设置为10以兼容qwen
    DEFAULT_CONCURRENCY: 3, // DashScope 默认并发较敏感，建议从 5 降到 3
    DEFAULT_MAX_RETRIES: 3,
    MAX_TOKENS: 8191,
};
/** 文本向量化模型名称 */
export const EMBEDDING_MODEL: string =
    process.env.EMBEDDING_MODEL || EMBEDDING_CONFIG.DEFAULT_EMBEDDING;
export const EMBEDDING_DIMENSIONS = process.env.EMBEDDING_DIMENSIONS
    ? Number(process.env.EMBEDDING_DIMENSIONS)
    : EMBEDDING_CONFIG.DEFAULT_EMBEDDING_DIMENSIONS;

// ── 记忆选择层配置常量 ──────────────────────────────────────────

/** A0 向量分数绝对地板：候选集最高 vectorScore 低于此值时直接返回空 selected，防止均匀噪声场景 */
export const MEMORY_SELECTION_MIN_VECTOR_SCORE = 0.5;

/** 百分位截断阈值（0-1），保留 rrfScore >= P70 的候选 */
export const MEMORY_SELECTION_PERCENTILE = 0.7;

/** 百分位算法：线性插值法（与 NumPy 兼容） */
export const MEMORY_SELECTION_PERCENTILE_ALGORITHM = 'linear' as const;

/** 硬上限：最终返回的最大记忆条数 */
export const MEMORY_SELECTION_HARD_MAX = 8;

/**
 * 语义去重相似度阈值
 * TODO: 需按 Qwen text-embedding-v4 实际分布校准
 * TODO: 两周后基于 metadata.droppedByDedup 日志校准 Qwen text-embedding-v4 最优阈值
 */
export const MEMORY_SELECTION_DEDUP_THRESHOLD = 0.88;

/** 是否启用时效性提权（当前关闭，Pipeline C 骨架） */
export const MEMORY_SELECTION_RECENCY_ENABLED = false;

/** 时效性地板系数：最低权重不低于此值 */
export const MEMORY_SELECTION_RECENCY_FLOOR = 0.7;

/** 时效性半衰期（天）：每过半衰期权重衰减一半 */
export const MEMORY_SELECTION_RECENCY_HALF_LIFE = 14;

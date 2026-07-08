/** AI 服务配置常量，集中管理避免魔法字符串 */
export const AI_CONFIG = {
    DEFAULT_MODEL: 'qwen3.7-plus',
    DEFAULT_TIMEOUT: 30_000, // 30s 超时
    DEFAULT_MAX_RETRIES: 2, // 重试次数
} as const;

/** 对话/生成模型名称 */
export const AI_MODEL: string = process.env.AI_MODEL || AI_CONFIG.DEFAULT_MODEL;

export const EMBEDDING_CONFIG = {
    DEFAULT_EMBEDDING: 'text-embedding-v4',
    DEFAULT_EMBEDDING_DIMENSIONS: 1536, // text-embedding-v4 支持64~2048维用户自定义向量维度。
    DEFAULT_MAX_BATCH_SIZE: 10, // openai最大限制100, qwen DashScope最大限制10, 这里设置为10以兼容qwen
    DEFAULT_CONCURRENCY: 3, // DashScope 默认并发较敏感，建议从 5 降到 3
    DEFAULT_MAX_RETRIES: 3,
};
/** 文本向量化模型名称 */
export const EMBEDDING_MODEL: string =
    process.env.EMBEDDING_MODEL || EMBEDDING_CONFIG.DEFAULT_EMBEDDING;
export const EMBEDDING_DIMENSIONS = process.env.EMBEDDING_DIMENSIONS
    ? Number(process.env.EMBEDDING_DIMENSIONS)
    : EMBEDDING_CONFIG.DEFAULT_EMBEDDING_DIMENSIONS;

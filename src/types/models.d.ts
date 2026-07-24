import mongoose, { Schema, Document } from 'mongoose';
/** 笔记本 */
export interface Notebook extends Document {
    title: string;
    createUser: string;
    updateUser: string;
    createdAt: Date;
    updatedAt: Date;
    isDeleted: boolean; // 软删除标识位
}
/** 笔记 */
export type Note = {
    notebookId: mongoose.Types.ObjectId;
    title: string;
    content: string;
    createUser: string;
    updateUser: string;
    isDeleted: boolean;
};

/** 会话消息 */
export interface ChatMessage extends Document {
    id: string; // mongodb ObjectId 自动生成
    sessionId: string; // 关联会话的唯一标识（无前缀 sessionId）
    role: 'system' | 'user' | 'assistant' | 'tool' | string;
    content: string; // 消息内容
    timestamp: number; // 消息发送的时间戳（毫秒）
    msgId: string; // UUID v7，消息级唯一标识 ← sourceMessageIds 引用这个
    traceId: string; // 请求级追踪标识 ← 保留，继续用于全链路追踪
    isDeleted: boolean; // 软删除标识
}

/** 长期记忆的语义分类枚举 (对应 Prompt 的扩展) */
type MemoryCategory =
    | 'preference'
    | 'personal_info'
    | 'decision'
    | 'behavior_pattern'
    | 'skill'
    | 'goal'
    | 'event'
    | string;

type MetaData = {
    // 可观测性追踪
    tracing?: {
        traceIds: string[]; // 生成该记忆涉及的 LLM 调用 traceId
        // spanIds?: string[]; // 未来可能需要更细粒度的 span
    };

    // 记忆质量标注（未来扩展）
    quality?: {
        confidenceScore?: number; // RRF 融合分数 or rerank 分数
        compressionRatio?: number; // 原始消息数 / 记忆条数
        feedbackLabel?: 'good' | 'bad' | 'irrelevant'; // 用户反馈
    };

    // 来源上下文（未来扩展）
    source?: {
        modelId?: string; // 生成摘要的模型
        embeddingModelVersion?: string; // 向量化所用模型版本
    };
} & Record<string, any>;

/** 长期记忆 */
export interface MemoryFact extends Document {
    memoryKey: string; // 应存用户id
    content: string;
    sourceMessageIds: string[]; // 对应的源消息ID
    embedding?: number[];
    confidence: number;
    createdAt: Date;
    updatedAt: Date;
    notebookId?: string; // 笔记本隔离（可选，兼容全局记忆null）
    // 区分对话事实与笔记分块，便于差异化检索；预留 media 类型，未来支持图文检索
    type: 'fact' | 'note_chunk' | 'media';
    contentHash?: string; // 内容指纹，用于语义去重（防止相似事实重复入库）
    metadata?: MetaData; // 元数据预留扩展字段
    // 预留字段
    mediaUrl?: string; // 预留媒体资源地址
    mediaType?: 'image' | 'audio' | 'video'; // 预留媒体类型

    // 语义类型
    category?: MemoryCategory;
}

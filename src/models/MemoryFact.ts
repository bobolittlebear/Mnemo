// src/models/MemoryFact.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

// 语义分类枚举 (对应 Prompt 的扩展)
// 建议用 String 存储而不是严格的 Enum，方便未来随时让 Prompt 增加新分类
export type MemoryCategory =
    | 'preference'
    | 'personal_info'
    | 'decision'
    | 'behavior_pattern'
    | 'skill'
    | 'goal'
    | 'event'
    | string;
export interface IMemoryFact extends Document {
    memoryKey: string;
    content: string;
    sourceMessageIds: string[];
    embedding?: number[];
    confidence: number;
    createdAt: Date;
    updatedAt: Date;
    notebookId?: string; // 笔记本隔离（可选，兼容全局记忆null）
    // 区分对话事实与笔记分块，便于差异化检索；预留 media 类型，未来支持图文检索
    type: 'fact' | 'note_chunk' | 'media';
    contentHash?: string; // 内容指纹，用于语义去重（防止相似事实重复入库）
    metadata?: Record<string, any>; // 预留扩展字段（如 tags, sourceUrl 等）
    // 预留字段
    mediaUrl?: string; // 预留媒体资源地址
    mediaType?: 'image' | 'audio' | 'video'; // 预留媒体类型

    // 语义类型
    category?: MemoryCategory;
}

const MemoryFactSchema = new Schema<IMemoryFact>(
    {
        memoryKey: { type: String, required: true },

        content: { type: String, required: true, trim: true },

        sourceMessageIds: {
            type: [String],
            required: true,
            validate: [
                (arr: string[]) => arr.length > 0,
                'sourceMessageIds cannot be empty',
            ],
        },

        // embedding 字段默认可选，无需额外配置
        embedding: { type: [Number], default: undefined },

        confidence: { type: Number, required: true, min: 0, max: 1 },

        // 新增字段定义
        notebookId: { type: String, default: null },
        type: {
            type: String,
            enum: ['fact', 'note_chunk', 'media'],
            default: 'fact',
        },
        contentHash: { type: String, sparse: true },
        metadata: { type: Schema.Types.Mixed, default: {} },

        mediaUrl: { type: String, default: null },
        mediaType: {
            type: String,
            enum: ['image', 'audio', 'video'],
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    },
);

// 时间线检索，支撑“获取某用户/会话最近 N 条记忆”的场景。
MemoryFactSchema.index({ memoryKey: 1, createdAt: -1 });

// 全文检索索引（用于 BM25 关键词匹配，支撑混合检索）
MemoryFactSchema.index(
    { content: 'text' },
    {
        name: 'memory_content_text_index',
        weights: { content: 10 },
        language_override: 'none', // 中文场景建议关闭词干分析
        default_language: 'none',
    },
);

// 混合检索的前置过滤器
MemoryFactSchema.index({ memoryKey: 1, notebookId: 1, type: 1, createdAt: -1 });

// 精确去重唯一索引（替代原来的 contentHash sparse 单字段索引）
MemoryFactSchema.index(
    { memoryKey: 1, contentHash: 1 },
    {
        unique: true, // 约束(memoryKey, contentHash)不能出现重复值
        sparse: true, // 稀疏索引
        name: 'memkey_contentHash_unique',
    },
);

export const MemoryFact: Model<IMemoryFact> =
    mongoose.models.MemoryFact ||
    mongoose.model<IMemoryFact>('MemoryFact', MemoryFactSchema);

// src/models/MemoryFact.ts
import type { MemoryFact as RawMemoryFact } from '@/types/models';
import mongoose, { Schema, Model } from 'mongoose';

const MemoryFactSchema = new Schema<RawMemoryFact>(
    {
        // 应改为userId, 目前先存userId
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
        contentHash: { type: String, required: true },
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
        /** sparse 稀疏索引, 仅对包含索引字段的文档建立索引条目,
         * 允许集合中存在没有 contentHash 的文档
         * 多个缺失字段的文档不会因 null == null 而触发唯一冲突
         */
        sparse: true,
        name: 'memkey_contentHash_unique',
    },
);

export const MemoryFact: Model<RawMemoryFact> =
    mongoose.models.MemoryFact ||
    mongoose.model<RawMemoryFact>('MemoryFact', MemoryFactSchema);

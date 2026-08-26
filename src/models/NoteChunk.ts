// src/models/NoteChunk.ts
import mongoose, { Schema, Model } from 'mongoose';
import type { NoteChunk as NoteChunkType } from '@/types/models';

const NoteChunkSchema = new Schema<NoteChunkType>(
    {
        noteId: {
            type: Schema.Types.ObjectId,
            ref: 'Note',
            required: true,
        },
        notebookId: {
            type: Schema.Types.ObjectId,
            ref: 'Notebook',
            required: true,
        },
        userId: { type: String, required: true },

        title: { type: String, required: true, trim: true },

        chunkType: {
            type: String,
            enum: ['parent', 'child'],
            required: true,
        },
        // 自引用父块（child → parent），parent 块此字段为 undefined
        parentId: {
            type: Schema.Types.ObjectId,
            ref: 'NoteChunk',
            default: null,
        },

        sectionPath: { type: [String], default: [] },

        chunkIndex: { type: Number, required: true },

        content: { type: String, required: true },

        // 向量字段默认可选，Atlas Vector Search 索引在云端手动创建，不写进代码
        embedding: { type: [Number], default: undefined },

        // 中文分词后的搜索文本，用于全文检索（对齐 MemoryFact 写法）
        searchText: { type: String, default: '' },

        contentHash: { type: String, required: true },
    },
    {
        timestamps: true,
    },
);

// 按笔记查块（含父子块过滤），支撑"按笔记加载全部块"
NoteChunkSchema.index({ noteId: 1, chunkType: 1 });

// 用户维度检索（笔记本隔离 + 类型过滤）
NoteChunkSchema.index({ userId: 1, notebookId: 1, chunkType: 1 });

// 全文检索索引（用于 BM25 关键词匹配，支撑混合检索）
// 中文场景关闭词干分析，对齐 MemoryFact 的 searchText 索引写法
NoteChunkSchema.index(
    { searchText: 'text' },
    {
        name: 'notechunk_searchText_text_index',
        weights: { searchText: 10 },
        language_override: 'none',
        default_language: 'none',
    },
);

export const NoteChunk: Model<NoteChunkType> =
    mongoose.models.NoteChunk ||
    mongoose.model<NoteChunkType>('NoteChunk', NoteChunkSchema);

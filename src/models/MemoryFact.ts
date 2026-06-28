// src/models/MemoryFact.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IMemoryFact extends Document {
    memoryKey: string;
    content: string;
    sourceMessageIds: string[];
    embedding?: number[];
    confidence: number;
    createdAt: Date;
    updatedAt: Date;
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
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    },
);

// 消息去重复合唯一性所以
MemoryFactSchema.index({ memoryKey: 1, sourceMessageIds: 1 }, { unique: true });
// 按用户最近时间查询的性能优化索引
MemoryFactSchema.index({ memoryKey: 1, createdAt: -1 });

export const MemoryFact: Model<IMemoryFact> =
    mongoose.models.MemoryFact ||
    mongoose.model<IMemoryFact>('MemoryFact', MemoryFactSchema);

import mongoose, { Schema, Document } from 'mongoose';

export interface ISession extends Document {
    userId: string;
    sessionId: string;
    title: string;
    status: 'active' | 'archived' | 'deleted';
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
    {
        userId: {
            type: String,
            required: true,
        },
        sessionId: {
            type: String,
            required: true,
            unique: true,
        },
        title: {
            type: String,
            default: '',
        },
        status: {
            type: String,
            enum: ['active', 'archived', 'deleted'],
            default: 'active',
        },
        lastActiveAt: {
            type: Date,
        },
        createdAt: {
            type: Date,
        },
        updatedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
    },
);

// 列表查询索引：按 userId 查，按 lastActiveAt 倒序
sessionSchema.index({ userId: 1, lastActiveAt: -1 });

export default mongoose.model<ISession>('Session', sessionSchema);

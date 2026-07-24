// src/models/ChatMessage.ts
/**
 * AI对话消息模型 - 支持按用户查询、按时间倒序分页
 */
import { createLogger } from '@/lib/logger';
import type { ChatMessage } from '@/types/models';
import { MAX_MESSAGE_PER_SESSION } from '@/utils/constant';
import mongoose, { Schema, Document, Model } from 'mongoose';

// 定义静态方法
interface ChatMessageModel extends Model<ChatMessage> {
    trimOldMessages(sessionId: string, maxMessages?: number): Promise<void>;
}

const chatMessageSchema = new Schema<ChatMessage>(
    {
        sessionId: {
            type: String,
            required: true,
            index: true, // 核心索引：支持按用户快速查询
        },
        msgId: {
            type: String,
            required: true,
        },
        role: {
            type: String,
            required: true,
            enum: ['user', 'assistant', 'system'],
        },
        content: {
            type: String,
            required: true,
        },
        traceId: {
            type: String,
            required: true,
        },
        timestamp: {
            type: Number,
            required: true,
            index: true, // 复合索引的一部分：支持按时间排序和分页
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: false, // 我们使用自定义的 timestamp 字段
        collection: 'chat_messages', // 指定集合名称
    },
);

// 创建复合索引：查询特定用户的消息并按时间倒序
chatMessageSchema.index({ sessionId: 1, timestamp: -1 });

//  使用静态方法而不是post钩子，因为如果一次性插入2条数据，则会执行两次钩子
// post('save') 是在当前文档保存成功后同步或微任务执行的。
// 这意味着，如果不做额外处理，它会阻塞当前请求的返回，或者在后台引发难以追踪的异步错误。
chatMessageSchema.statics.trimOldMessages = async function (
    sessionId: string,
    maxMessages: number = MAX_MESSAGE_PER_SESSION,
) {
    const logger = createLogger('mongodb');
    try {
        // 1. 找出需要被删除的消息的 _id
        // 逻辑：按时间正序排列，跳过最新的 maxMessages 条，剩下的就是要删除的
        const messagesToDelete: ChatMessage[] = await this.find({ sessionId })
            .sort({ _id: 1 }) // 按 ObjectId 正序（等同于插入时间正序）
            .skip(maxMessages)
            .select('_id')
            .lean(); // lean() 提高查询性能，只返回纯 JSON

        if (messagesToDelete.length > 0) {
            const idsToDelete = messagesToDelete.map((m) => m._id);
            await this.deleteMany({ _id: { $in: idsToDelete } });
            logger.info(`Trimmed old messages`, {
                sessionId,
                length: idsToDelete.length,
            });
        }
    } catch (err) {
        logger.warn('Trim old messages error:', err);
    }
};

export default mongoose.model<ChatMessage, ChatMessageModel>(
    'ChatMessage',
    chatMessageSchema,
);

import { MemoryFact } from '@/models/MemoryFact';
import { createLogger } from '@/lib/logger';
import { generateContentHash } from '@/util/tool';

/**
 * 提取出的事实数据结构
 */
export interface ExtractedFact {
    content: string;
    embedding: number[];
    confidence: number; // LLM 提取的置信度
    category?: string; // 语义分类
    metadata?: Record<string, any>;
}

/**
 * 入库时的上下文元数据
 */
export interface IngestionContext {
    memoryKey: string;
    sourceMessageIds: string[]; // 触发本次提取的原始消息 ID
    notebookId?: string; // 笔记本隔离 ID
    type?: 'fact' | 'note_chunk' | 'media'; // 默认为 'fact'
}

/**
 * 入库结果统计
 */
export interface IngestionResult {
    totalProcessed: number;
    inserted: number;
    updated: number;
    skipped: number; // 如果未来加入向量相似度去重，这里会记录跳过数
}

const logger = createLogger('rag');

/**
 * 核心入库方法：幂等写入 + contentHash 去重
 * 使用 bulkWrite + upsert 保证幂等性和高性能
 */
export async function ingestMemoryFacts(
    facts: ExtractedFact[],
    context: IngestionContext,
): Promise<IngestionResult> {
    if (!facts || facts.length === 0) {
        return { totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 };
    }

    const startTime = Date.now();
    const result: IngestionResult = {
        totalProcessed: facts.length,
        inserted: 0,
        updated: 0,
        skipped: 0,
    };

    try {
        // 1. 构建 bulkWrite 操作数组
        const operations = facts.map((fact) => {
            const contentHash = generateContentHash(fact.content);

            return {
                updateOne: {
                    // Filter 仅依赖 memoryKey + contentHash，实现租户/会话级精确去重
                    // 注意：必须加上 memoryKey，防止不同用户的相同事实被错误合并
                    filter: {
                        memoryKey: context.memoryKey,
                        contentHash: contentHash,
                    },
                    // Update: 存在则更新，不存在则插入
                    update: {
                        $set: {
                            content: fact.content,
                            embedding: fact.embedding, // 更新向量（防止模型升级后向量维度/语义变化，覆盖旧向量）
                            confidence: fact.confidence,
                            category: fact.category,
                            metadata: fact.metadata || {},
                            updatedAt: new Date(),
                        },
                        $setOnInsert: {
                            // 仅在首次插入时设置的字段
                            memoryKey: context.memoryKey,
                            type: context.type || 'fact',
                            notebookId: context.notebookId,
                            contentHash: contentHash,
                            createdAt: new Date(),
                            // 已移除 sourceMessageIds，避免与 $addToSet 冲突
                        },
                        // 使用 $each 将数组中的 ID 逐个去重追加, $addToSet 在 upsert 插入时会自动创建数组，无需 $setOnInsert
                        $addToSet: {
                            sourceMessageIds: {
                                $each: context.sourceMessageIds,
                            },
                        },
                    },
                    // Upsert: 关键配置，实现“不存在则插入”
                    upsert: true,
                },
            };
        });

        // 2. 执行批量写入
        // ordered: false 允许 MongoDB 并行执行操作，且某一条失败不会阻断后续操作
        const bulkWriteResult = await MemoryFact.bulkWrite(operations, {
            ordered: false,
            // 如果你使用的是 Mongoose，可能需要加上 writeConcern 保证写入可靠性
            writeConcern: { w: 'majority' },
        });

        // 3. 解析结果
        // 注意：不同版本的 Mongoose/MongoDB 驱动返回的统计字段名可能略有不同
        // 通常 insertedCount 和 modifiedCount 是最可靠的
        result.inserted = bulkWriteResult.insertedCount || 0;
        result.updated = bulkWriteResult.modifiedCount || 0;

        // 如果 totalProcessed > inserted + updated，说明有些操作匹配到了但没修改（upserted 但没变）
        // 在 MVP 阶段，我们主要关注 inserted 和 updated

        const duration = Date.now() - startTime;
        logger.info(
            `[MemoryIngestion] 入库完成. memoryKey: ${context.memoryKey}, ` +
                `Total: ${result.totalProcessed}, Inserted: ${result.inserted}, ` +
                `Updated: ${result.updated}, Duration: ${duration}ms`,
        );

        return result;
    } catch (error: any) {
        logger.error(
            `[MemoryIngestion] 入库失败. memoryKey: ${context.memoryKey}, Error: ${error.message}`,
            { stack: error.stack },
        );
        throw new Error(`Memory ingestion failed: ${error.message}`);
    }
}

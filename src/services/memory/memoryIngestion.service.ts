// src/services/memory/memoryIngestion.service.ts

import { MemoryFact } from '@/models/MemoryFact';
import { createLogger } from '@/lib/logger';
import { generateContentHash } from '@/utils/tool';
import type {
    EmbeddedFact,
    IngestionContext,
    IngestionResult,
} from '@/types/memory';

const logger = createLogger('ltm');

/**
 * 幂等入库：contentHash 去重 + bulkWrite upsert
 *
 * 职责边界：仅做数据写入
 * 不涉及：LLM、向量化、Redis
 */
export async function ingestMemoryFacts(
    facts: EmbeddedFact[],
    context: IngestionContext,
): Promise<IngestionResult> {
    if (!facts?.length) {
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
                    // filter 仅依赖 memoryKey + contentHash，实现租户/会话级精确去重
                    filter: {
                        memoryKey: context.memoryKey,
                        contentHash,
                    },
                    update: {
                        $set: {
                            content: fact.content,
                            embedding: fact.embedding,
                            confidence: fact.confidence,
                            category: fact.category,
                            metadata: fact.metadata || {},
                            updatedAt: new Date(),
                            sourceMessageIds: fact.sourceMessageIds,
                        },
                        $setOnInsert: {
                            memoryKey: context.memoryKey,
                            type: context.type || 'fact',
                            notebookId: context.notebookId,
                            contentHash,
                            createdAt: new Date(),
                        },
                        // $addToSet: {
                        //     sourceMessageIds: {
                        //         $each: context.sourceMessageIds,
                        //     },
                        // },
                    },
                    upsert: true,
                },
            };
        });

        // 2. 批量写入
        const bulkWriteResult = await MemoryFact.bulkWrite(operations, {
            ordered: false,
            writeConcern: { w: 'majority' },
        });

        // 3. 解析结果
        // updateOne + upsert: true 时，新插入计入 upsertedCount 而非 insertedCount
        // insertedCount 只对 insertOne 操作有效
        result.inserted =
            (bulkWriteResult.insertedCount || 0) +
            (bulkWriteResult.upsertedCount || 0);
        result.updated = bulkWriteResult.modifiedCount || 0;

        logger.info(
            `入库完成 | memoryKey: ${context.memoryKey} | ` +
                `total: ${result.totalProcessed}, inserted: ${result.inserted}, ` +
                `updated: ${result.updated}, duration: ${Date.now() - startTime}ms`,
        );

        return result;
    } catch (error: any) {
        logger.error(
            `入库失败 | memoryKey: ${context.memoryKey} | ${error.message}`,
        );
        throw new Error(`Memory ingestion failed: ${error.message}`);
    }
}

// src/services/memory/memoryIngestion.service.ts

import { MemoryFact } from '@/models/MemoryFact';
import { createLogger } from '@/lib/logger';
import { generateContentHash } from '@/utils/tool';
import { tokenize, countTokens } from '@/utils/tokenizer';
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
            // 入库不截断 content：content 是事实源，token 预算属运行时呈现层问题。
            // content / embedding / contentHash / searchText / tokenCount 一律基于同一份全量
            // content（embedding 本就由全量原文生成），category 上限只在 M3 注入侧做防御截断。
            const contentHash = generateContentHash(fact.content);

            return {
                updateOne: {
                    // filter 仅依赖 userId + contentHash，实现租户/会话级精确去重
                    filter: {
                        userId: context.userId, // 改为userId
                        contentHash,
                    },
                    update: {
                        $set: {
                            content: fact.content,
                            searchText: tokenize(fact.content),
                            embedding: fact.embedding,
                            confidence: fact.confidence,
                            category: fact.category,
                            metadata: fact.metadata || {},
                            updatedAt: new Date(),
                            sourceMessageIds: fact.sourceMessageIds,
                            tokenCount: countTokens(fact.content),
                            // 写入点2：入库即视为「被实质使用」，刷新遗忘机制的时间戳
                            lastSignificantAt: new Date(),
                        },
                        // 软删复活：同 contentHash 重新入库即撤销软删。
                        // 必须用 $unset（移除字段），不能用 $set: null —— 读路径
                        // 判定的是 deletedAt: { $exists: false }，null 值会让该记录
                        // 被当成已删除而永久漏判（既搜不到也不再复活）。
                        // 对已删除/新建记录均为安全 no-op：字段不存在时无副作用。
                        $unset: { deletedAt: '' },
                        $setOnInsert: {
                            userId: context.userId,
                            type: context.type || 'fact',
                            notebookId: context.notebookId,
                            contentHash,
                            createdAt: new Date(),
                        },
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
            `入库完成 | userId: ${context.sessionId} | ` +
                `total: ${result.totalProcessed}, inserted: ${result.inserted}, ` +
                `updated: ${result.updated}, duration: ${Date.now() - startTime}ms`,
        );

        return result;
    } catch (error: any) {
        logger.error(
            `入库失败 | userId: ${context.sessionId} | ${error.message}`,
        );
        throw new Error(`Memory ingestion failed: ${error.message}`);
    }
}

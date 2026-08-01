// src/services/memory/memoryPipeline.service.ts
/**
 * 记忆提取服务
 * 触发方式：
 * 1. 明确的会话终止信号: endSession
 * 2. STM超时静默触发
 * 3. 每日凌晨兜底扫描
 */

import memoryExtractionService from './memoryExtraction.service';
import { ingestMemoryFacts } from './memoryIngestion.service';
import STM from '@/utils/shortTermMemory';
import { generateEmbeddings } from '@/lib/embedding';
import { createLogger } from '@/lib/logger';
import { MemoryFact } from '@/models/MemoryFact';
import type {
    EmbeddedFact,
    IngestionContext,
    IngestionResult,
} from '@/types/memory';
import type { RawMessage } from '@/types/chat';
import type { SessionIdentityResolver } from './sessionIdentity.resolver';

const logger = createLogger('ltm');

class MemoryPipelineService {
    private readonly resolver: SessionIdentityResolver;

    constructor(resolver: SessionIdentityResolver) {
        this.resolver = resolver;
    }
    /**
     * 长期记忆提取完整管道
     *
     * 编排流程：
     * 1. 幂等检查（消息级，避免重复调 LLM）
     * 2. LLM 提取 + 清洗 → RawFact[]
     * 3. 批量向量化 → EmbeddedFact[]
     * 4. 入库去重（内容级 contentHash）
     * 5. 更新 Redis 提取标记（仅全链路成功后）
     *
     * @returns 入库结果统计
     */
    async run(
        context: IngestionContext,
        messages: RawMessage[],
    ): Promise<IngestionResult> {
        logger.info('开始执行pipeline, 传入参数：', {
            msgLength: messages.length,
        });
        if (!messages.length) {
            return { totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 };
        }

        const { sessionId } = context;
        const userId =
            context.userId ?? (await this.resolver.resolve(sessionId));
        if (!userId) {
            logger.warn('无法解析 userId，跳过提取', { sessionId });
            return { totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 };
        }

        const sourceIds = messages.map((m) => m.msgId);
        const lastMsgId = sourceIds[sourceIds.length - 1]!;

        // ── 1. 一级防御：游标快速过滤（O(1) 开销）──
        const lastExtractedId = await STM.getLastExtractedMsgId(sessionId);
        if (lastExtractedId && lastMsgId <= lastExtractedId) {
            // 整个批次的最大ID都小于等于已提取游标 → 整批已处理，直接返回
            logger.debug('Skip extraction: entire batch already processed', {
                sessionId,
                lastMsgId,
                lastExtractedId,
            });
            return {
                totalProcessed: sourceIds.length,
                inserted: 0,
                updated: 0,
                skipped: sourceIds.length,
            };
        }
        // ── 2. 二级防御：DB精确去重（仅对游标之后的消息生效）──
        // 优化：只查询 > lastExtractedId 的消息，大幅缩小 $in 扫描范围
        const idsToCheck = lastExtractedId
            ? sourceIds.filter((id) => id > lastExtractedId)
            : sourceIds;

        let newMsgIds = idsToCheck;

        if (idsToCheck.length > 0) {
            const existingDocs = await MemoryFact.find({
                userId,
                sourceMessageIds: { $in: sourceIds },
            })
                .select('sourceMessageIds')
                .lean();

            // 收集所有已存在于数据库中的消息ID（可能来自多条不同的fact记录）
            const processedIds = new Set(
                existingDocs.flatMap((doc) => doc.sourceMessageIds),
            );
            // 过滤出真正未处理过的新消息ID
            newMsgIds = sourceIds.filter((id) => !processedIds.has(id));
        }
        // 合并：游标之前的消息视为已处理，只保留真正需要提取的新消息
        const skippedCount = sourceIds.length - newMsgIds.length;

        if (newMsgIds.length === 0) {
            await STM.setLastExtractedMsgId(sessionId, lastMsgId);
            return {
                totalProcessed: sourceIds.length,
                inserted: 0,
                updated: 0,
                skipped: skippedCount,
            };
        }

        const newMessages = messages.filter((m) => newMsgIds.includes(m.msgId));

        logger.debug('根据游标过滤该提取的msg数量：', {
            newMsgIds,
        });

        // ── 2. LLM 提取 + 清洗 ──
        // TODO: 从数据库中查询existingMemories，用于给llm确定记忆去重/更新
        const rawFacts = await memoryExtractionService.extractFacts(
            newMessages,
            {
                userId, // 后续统一为userId/sessionId
                existingMemories: [], // TODO
            },
        );
        logger.debug('提取的事实：', {
            rawFacts: rawFacts.map((i) => i.content),
        });

        if (rawFacts.length === 0) {
            await STM.setLastExtractedMsgId(sessionId, lastMsgId);
            return { totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 };
        }

        // ── 3. 批量向量化 ──
        let embeddings: number[][];
        try {
            const res = await generateEmbeddings(
                rawFacts.map((f) => f.content),
            );
            embeddings = res.embeddings;
        } catch (error) {
            logger.error('Embedding failed', { sessionId, error });
            throw error;
        }

        // ── 4. 组装 + 入库 ──
        const embeddedFacts: EmbeddedFact[] = rawFacts.map((fact, i) => ({
            ...fact,
            embedding: embeddings[i]!,
        }));

        const result = await ingestMemoryFacts(embeddedFacts, {
            ...context,
            userId,
        });

        // ── 5. 更新标记（仅全链路成功后）──
        await STM.setLastExtractedMsgId(sessionId, lastMsgId);
        logger.info(`LTM Pipeline done`, {
            sessionId,
            inserted: result.inserted,
            updated: result.updated,
        });

        return result;
    }
}

export default MemoryPipelineService;

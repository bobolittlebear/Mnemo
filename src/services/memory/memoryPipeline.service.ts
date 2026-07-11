// src/services/memory/memoryPipeline.service.ts
import memoryExtractionService from './memoryExtraction.service';
import { ingestMemoryFacts } from './memoryIngestion.service';
import STM from '@/utils/shortTermMemory';
import { generateEmbeddings } from '@/lib/embedding';
import { getExtractionKey } from '@/utils/tool';
import { createLogger } from '@/lib/logger';
import { MemoryFact } from '@/models/MemoryFact';
import type {
    EmbeddedFact,
    IngestionContext,
    IngestionResult,
} from '@/types/memory';

interface RawMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

const logger = createLogger('ltm');
class MemoryPipelineService {
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
        sessionId: string,
        messages: RawMessage[],
    ): Promise<IngestionResult> {
        if (!messages.length) {
            return { totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 };
        }

        const memoryKey = getExtractionKey(sessionId);
        const sourceIds = messages.map((m) => m.id);
        const lastMsgId = sourceIds[sourceIds.length - 1]!;

        // ── 1. 幂等检查：这些消息是否已提取过 ──
        const alreadyExtracted = await MemoryFact.findOne({
            memoryKey,
            sourceMessageIds: { $in: sourceIds },
        }).lean();

        if (alreadyExtracted) {
            logger.debug('Skip duplicate extraction', { memoryKey });
            await STM.setLastExtractedMsgId(sessionId, lastMsgId);
            return { totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 };
        }

        // ── 2. LLM 提取 + 清洗 ──
        const rawFacts = await memoryExtractionService.extractFacts(messages);

        if (rawFacts.length === 0) {
            await STM.setLastExtractedMsgId(sessionId, lastMsgId);
            logger.info('No valid facts, marker updated', { memoryKey });
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
            logger.error('Embedding failed', { memoryKey, error });
            throw error;
        }

        // ── 4. 组装 + 入库 ──
        const embeddedFacts: EmbeddedFact[] = rawFacts.map((fact, i) => ({
            ...fact,
            embedding: embeddings[i]!,
        }));

        const context: IngestionContext = {
            memoryKey,
            sourceMessageIds: sourceIds,
        };

        const result = await ingestMemoryFacts(embeddedFacts, context);

        // ── 5. 更新标记（仅全链路成功后）──
        await STM.setLastExtractedMsgId(sessionId, lastMsgId);
        logger.info(
            `Pipeline done | inserted: ${result.inserted}, updated: ${result.updated}`,
            { memoryKey },
        );

        return result;
    }
}

export default new MemoryPipelineService();

/**
 * 集成方式
import memoryPipeline from '@/services/memory/memoryPipeline.service';

// 第一层：SSE [DONE] 后异步触发（不阻塞响应）
setImmediate(async () => {
  try {
    await memoryPipeline.run(sessionId, messagesToExtract);
  } catch (error) {
    logger.error('Pipeline failed', { sessionId, error });
  }
});

// 第二层：Cron 超时静默触发
// 扫描 STM中超时会话 → memoryPipeline.run()

// 第三层：每日凌晨兜底扫描
// 扫描所有未提取会话 → memoryPipeline.run()
 */

// src/services/memoryExtraction.service.ts
import { MemoryFact, IMemoryFact } from '@/models/MemoryFact';
import STM from '@/util/shortTermMemory';
import { generateEmbeddings } from '@/lib/embedding';
import { createLogger } from '@/lib/logger';
import { createChat } from './ai.service';
import { getExtractionKey } from '@/util/tool';
import { EXTRACTION_PROMPT } from '@/util/constant';

interface RawMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ExtractedFact {
    content: string;
    confidence: number;
}

const logger = createLogger('ltm');

class MemoryExtractionService {
    /**
     * 文本清洗管线
     */
    private cleanText(text: string): string {
        return text
            .replace(/\s+/g, ' ') // 合并空白
            .replace(/[^\w\s\u4e00-\u9fff.,!?;:()\-]/g, '') // 保留中英文+基本标点
            .trim();
    }

    /**
     * 核心提取方法
     * @param sessionId 用户会话标识
     * @param messages 待提取的消息列表（已过滤系统消息）
     */
    async extract(sessionId: string, messages: RawMessage[]): Promise<number> {
        if (!messages.length) return 0;

        const memoryKey = getExtractionKey(sessionId);
        const sourceIds = messages.map((m) => m.id);

        // 1. 幂等前置检查：避免重复提取
        const existing = await MemoryFact.findOne({
            memoryKey,
            sourceMessageIds: { $in: sourceIds },
        }).lean();

        if (existing) {
            logger.debug('Skip duplicate extraction', { memoryKey });
            await STM.setLastExtractedMsgId(
                sessionId,
                sourceIds[sourceIds.length - 1]!,
            );
            return 0;
        }

        // 2. 构建 Prompt 并调用 LLM
        const conversationText = messages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n');

        const prompt = EXTRACTION_PROMPT.replace(
            '{{CONVERSATION}}',
            conversationText,
        );

        let facts: ExtractedFact[] = [];
        try {
            const llmResponse = await createChat(
                [{ content: prompt, role: 'system' }],
                { temperature: 0.1 },
            );
            facts = this.parseFacts(llmResponse?.content);
        } catch (error) {
            logger.error(`LLM extraction failed`, { memoryKey, error });
            throw error;
        }

        // // 3. 过滤低置信度事实
        // const validFacts = facts.filter((f) => f.confidence >= 0.6);

        // 3. 清洗 + 过滤（替换原简单置信度过滤）
        const validFacts: ExtractedFact[] = [];
        for (const fact of facts) {
            if (fact.confidence < 0.6) continue;

            const cleaned = this.cleanText(fact.content);
            // 过滤：清洗后为空 / 过短（<5字符无意义）
            if (!cleaned || cleaned.length < 5) continue;

            validFacts.push({ content: cleaned, confidence: fact.confidence });
        }

        // 4. 即使无有效事实，也要更新标记（避免重复处理闲聊）
        if (validFacts.length === 0) {
            await STM.setLastExtractedMsgId(
                sessionId,
                sourceIds[sourceIds.length - 1]!,
            );
            logger.info(`No valid facts extracted, marker updated`, {
                memoryKey,
            });
            return 0;
        }

        // 5. 批量写入 DB + 向量化
        let embeddings: number[][] = [];
        try {
            // 2.2 修复后的 generateEmbeddings 接受 string[]，返回 number[][]
            embeddings = await generateEmbeddings(
                validFacts.map((f) => f.content),
            );
        } catch (embError) {
            logger.error(`Batch embedding failed`, { memoryKey, embError });
            // 向量化整体失败则不写入，等待下次重试
            // TODO: 下次重试未实现，且上方已更新setLastExtractedMsgId, 发生错误时可能会漏存部分msg的事实
            throw embError;
        }

        // 6. 组装文档并写入
        const docsToSave: Partial<IMemoryFact>[] = validFacts.map(
            (fact, i) => ({
                memoryKey,
                content: fact.content, // 使用清洗后的内容
                sourceMessageIds: sourceIds,
                embedding: embeddings[i], // 直接取 number[]，无需额外处理
                confidence: fact.confidence,
            }),
        );

        if (docsToSave.length > 0) {
            // 使用 ordered: false 忽略部分重复键错误
            await MemoryFact.insertMany(docsToSave, { ordered: false });
        }

        // 7. 仅在全部成功后更新 Redis 标记
        await STM.setLastExtractedMsgId(
            sessionId,
            sourceIds[sourceIds.length - 1]!,
        );
        logger.info(`Extracted ${docsToSave.length} facts`, { memoryKey });

        return docsToSave.length;
    }

    /**
     * 鲁棒 JSON 解析器
     */
    private parseFacts(raw: string): ExtractedFact[] {
        try {
            // 去除 markdown 代码块包裹
            const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
            const parsed = JSON.parse(cleaned);

            if (!Array.isArray(parsed.facts)) {
                logger.warn('Invalid facts format:', { parsed });
                return [];
            }

            return parsed.facts.filter(
                (f: any) =>
                    typeof f.content === 'string' &&
                    typeof f.confidence === 'number',
            );
        } catch (e) {
            logger.error('JSON parse failed', { raw: raw.substring(0, 200) });
            return [];
        }
    }
}

const defaultMES = new MemoryExtractionService();
export default defaultMES;

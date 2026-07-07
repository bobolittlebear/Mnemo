// src/services/MemoryExtractionService.ts
import { MemoryFact, IMemoryFact } from '@/models/MemoryFact';
import STM from '@/util/shortTermMemory';
import { generateEmbedding } from '@/lib/embedding'; // 假设你的向量化封装
import { createLogger } from '@/lib/logger';
import { createChat } from './ai.service';

interface RawMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ExtractedFact {
    content: string;
    confidence: number;
}

const EXTRACTION_PROMPT = `你是一个记忆提取专家。请从以下对话中提取值得长期记住的事实（如偏好、个人信息、重要决定等）。
要求：
1. 仅返回 JSON 格式：{"facts": [{"content": "事实内容", "confidence": 0.0-1.0}]}
2. 如果没有值得记住的事实，返回 {"facts": []}
3. confidence 表示该事实的确定性，闲聊/猜测应低于 0.6
4. 不要提取临时性信息（如"今天好累"）

对话内容：
{{CONVERSATION}}`;

const logger = createLogger('ltm');

export class MemoryExtractionService {
    /**
     * 核心提取方法
     * @param memoryKey 用户会话标识
     * @param messages 待提取的消息列表（已过滤系统消息）
     */
    static async extract(
        memoryKey: string,
        messages: RawMessage[],
    ): Promise<number> {
        if (!messages.length) return 0;

        const sourceIds = messages.map((m) => m.id);

        // ⭐️ 1. 幂等前置检查：避免重复提取
        const existing = await MemoryFact.findOne({
            memoryKey,
            sourceMessageIds: { $in: sourceIds },
        }).lean();

        if (existing) {
            logger.debug('Skip duplicate extraction', { memoryKey });
            await STM.setLastExtractedMsgId(
                memoryKey,
                sourceIds[sourceIds.length - 1]!,
            );
            return 0;
        }

        // ⭐️ 2. 构建 Prompt 并调用 LLM
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
            // LLM 失败不更新标记，等待下次重试
            throw error;
        }

        // ⭐️ 3. 过滤低置信度事实
        const validFacts = facts.filter((f) => f.confidence >= 0.6);

        // ⭐️ 4. 即使无有效事实，也要更新标记（避免重复处理闲聊）
        if (validFacts.length === 0) {
            await STM.setLastExtractedMsgId(
                memoryKey,
                sourceIds[sourceIds.length - 1]!,
            );
            logger.info(`No valid facts extracted, marker updated`, {
                memoryKey,
            });
            return 0;
        }

        // ⭐️ 5. 批量写入 DB + 向量化
        const docsToSave: Partial<IMemoryFact>[] = [];
        for (const fact of validFacts) {
            try {
                const embedding = await generateEmbedding({
                    input: fact.content,
                });
                docsToSave.push({
                    memoryKey,
                    content: fact.content,
                    sourceMessageIds: sourceIds,
                    embedding,
                    confidence: fact.confidence,
                });
            } catch (embError) {
                logger.warn(
                    `Embedding failed for fact: ${fact.content}`,
                    embError,
                );
                // 单条向量化失败不影响其他事实
            }
        }

        if (docsToSave.length > 0) {
            // 使用 ordered: false 忽略部分重复键错误
            await MemoryFact.insertMany(docsToSave, { ordered: false });
        }

        // ⭐️ 6. 仅在全部成功后更新 Redis 标记
        await STM.setLastExtractedMsgId(
            memoryKey,
            sourceIds[sourceIds.length - 1]!,
        );
        logger.info(`Extracted ${docsToSave.length} facts`, { memoryKey });

        return docsToSave.length;
    }

    /**
     * 鲁棒 JSON 解析器
     */
    private static parseFacts(raw: string): ExtractedFact[] {
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

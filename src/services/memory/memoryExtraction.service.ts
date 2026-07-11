// src/services/memory/memoryExtraction.service.ts
import { createChat } from '../ai.service';
import { createLogger } from '@/lib/logger';
import { EXTRACTION_PROMPT } from '@/utils/constant';
import type { RawFact } from '@/types/memory';

interface RawMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

const logger = createLogger('ltm');

class MemoryExtractionService {
    /**
     * 文本清洗管线
     */
    private cleanText(text: string): string {
        return text
            .replace(/\s+/g, ' ')
            .replace(/[\x00-\x1f\x7f]/g, '') // 仅去控制字符
            .trim();
    }

    /**
     * 从对话中提取事实
     *
     * 职责边界：仅做 LLM 提取 + 清洗过滤
     * 不涉及：幂等检查、向量化、入库、Redis 标记
     *
     * @param messages 待提取的消息列表
     * @returns 清洗后的原始事实（不含 embedding）
     */
    async extractFacts(messages: RawMessage[]): Promise<RawFact[]> {
        if (!messages.length) return [];

        // 1. 构建 Prompt
        const conversationText = messages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n');

        const prompt = EXTRACTION_PROMPT.replace(
            '{{CONVERSATION}}',
            conversationText,
        );

        // 2. 调用 LLM 提取
        let rawFacts: RawFact[] = [];
        try {
            const llmResponse = await createChat(
                [{ content: prompt, role: 'system' }],
                { temperature: 0.1 },
            );
            rawFacts = this.parseFacts(llmResponse?.content);
        } catch (error) {
            logger.error('LLM extraction failed', { error });
            throw error;
        }

        // 3. 清洗 + 过滤
        const validFacts: RawFact[] = [];
        for (const fact of rawFacts) {
            if (fact.confidence < 0.6) continue;

            const cleaned = this.cleanText(fact.content);
            if (!cleaned || cleaned.length < 5) continue;

            validFacts.push({ ...fact, content: cleaned });
        }

        logger.info(
            `Extracted ${validFacts.length} valid facts from ${messages.length} messages`,
        );
        return validFacts;
    }

    /**
     * 鲁棒 JSON 解析器
     */
    private parseFacts(raw: string): RawFact[] {
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

export default new MemoryExtractionService();

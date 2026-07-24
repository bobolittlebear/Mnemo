// src/services/memory/chatMessageSource.ts
/**
 * MessageSource 的 Redis 实现：从 STM 读取（按 timestamp 升序）。
 *
 * 放在 trigger/ 之外：trigger 目录保持纯粹（零外部服务/模型依赖），
 * ChatMessage 模型由本实现持有，经组合根注入 createTriggerSystem。
 *
 * pipeline 内部已按游标(lastExtractedMsgId) + DB contentHash 去重，
 * 重复消息无害，故此处取全量交由 pipeline 过滤即可。// 优化，不要全量
 */
import STM from '@/utils/shortTermMemory';
import type { RawMessage } from '@/types/chat';
import type { MessageSource } from './trigger/messageSource';

export class STMChatMessageSource implements MessageSource {
    async getMessages(sessionId: string): Promise<RawMessage[]> {
        const messages = await STM.safeGetRecentRounds(sessionId);
        return messages;
    }
}

// src/services/memory/trigger/messageSource.ts
/**
 * 消息来源端口：规定「按 sessionId 取待提取消息」的契约，不限定数据源。
 * 具体实现（Mongo / STM / ...）由外层组合根注入，trigger 内不引用任何模型。
 */
import type { RawMessage } from '@/types/chat';

export interface MessageSource {
    /**
     * 取回某会话的全量消息（按时间正序），交由 pipeline 内部基于游标 + DB 去重。
     */
    getMessages(sessionId: string): Promise<RawMessage[]>;
}

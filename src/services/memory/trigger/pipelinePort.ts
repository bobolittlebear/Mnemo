// src/services/memory/trigger/pipelinePort.ts
/**
 * 触发器「向内端口」与「真实服务契约」的显式定义。
 *
 * - PipelineService：Coordinator 依赖的向内端口，只认 sessionId，
 *   不关心消息从哪来。trigger 内部仅依赖此契约。
 * - MemoryPipelineContract：真实提取服务的向外契约（双参，需要消息列表），
 *   由外层组合根注入实现，trigger 内不引用其具体类型。
 *
 * 二者签名不一致（单参 vs 双参）由 pipelineAdapter 桥接。
 */
import type { RawMessage } from '@/types/chat';
import type { IngestionResult } from '@/types/memory';

export interface PipelineService {
    run(sessionId: string): Promise<void>;
}

export interface MemoryPipelineContract {
    run(sessionId: string, messages: RawMessage[]): Promise<IngestionResult>;
}

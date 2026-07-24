// src/services/memory/trigger/pipelineAdapter.ts
/**
 * Adapter 工厂：桥接 Coordinator 的单参端口与真实服务的双参签名。
 *
 * 工作流：按 sessionId 从 MessageSource 取回消息 → 委托 MemoryPipelineContract.run 执行。
 * trigger 层无需真实服务即可测试（注入 mock 即可）。
 */
import type { PipelineService, MemoryPipelineContract } from './pipelinePort';
import type { MessageSource } from './messageSource';

export interface PipelineAdapterDeps {
    /** 真实提取服务（双参） */
    pipeline: MemoryPipelineContract;
    /** 消息来源 */
    messages: MessageSource;
}

export function createPipelineAdapter(
    deps: PipelineAdapterDeps,
): PipelineService {
    return {
        async run(sessionId: string): Promise<void> {
            const messages = await deps.messages.getMessages(sessionId);
            await deps.pipeline.run(sessionId, messages);
        },
    };
}

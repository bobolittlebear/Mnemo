// src/services/memory/trigger/index.ts
/**
 * 触发器纯工厂：createTriggerSystem(deps)。
 *
 * 本模块保持纯粹 —— 不 import 任何外部服务。
 * 所有外部依赖（redis 客户端、真实提取管道、消息来源）均由外层组合根
 * （src/services/memory/index.ts）注入。trigger 内部组件不得反向 import 外层，
 * 以免形成循环依赖。
 *
 * 会话标识约定：调用方传入的 sessionId 无前缀。
 */
import type { RedisClientType } from 'redis';
import { DistributedLock } from './distributedLock';
import { TerminalStateManager } from './terminalStateManager';
import { ProcessingGuard } from './processingGuard';
import { MemoryTriggerCoordinator } from './memoryTriggerCoordinator';
import type { CoordinatorMetrics } from './memoryTriggerCoordinator';
import { MessageCounter } from './messageCounter';
import { SessionEndTrigger } from './sessionEndTrigger';
import { createPipelineAdapter } from './pipelineAdapter';
import type { PipelineService, MemoryPipelineContract } from './pipelinePort';
import type { MessageSource } from './messageSource';
import sessionMemoryLifecycle from './sessionMemoryLifecycle';

export { default as sessionMemoryLifecycle } from './sessionMemoryLifecycle';
export type { PipelineService, MemoryPipelineContract } from './pipelinePort';
export type { MessageSource } from './messageSource';
export { createPipelineAdapter } from './pipelineAdapter';

/**
 * createTriggerSystem 的依赖契约：所有外部服务由调用方注入。
 */
export interface TriggerSystemDeps {
    redis: RedisClientType;
    /** 真实提取服务（双参契约） */
    pipeline: MemoryPipelineContract;
    /** 消息来源 */
    messages: MessageSource;
    metrics?: CoordinatorMetrics;
}

export interface TriggerSystem {
    coordinator: MemoryTriggerCoordinator;
    messageCounter: MessageCounter;
    sessionEndTrigger: SessionEndTrigger;
    /** 会话生命周期单例（终态清理 / 续聊重置 / 活跃时间） */
    lifecycle: typeof sessionMemoryLifecycle;
    /** 桥接后的单参管道端口 */
    pipeline: PipelineService;
}

export function createTriggerSystem(deps: TriggerSystemDeps): TriggerSystem {
    const lock = new DistributedLock(deps.redis);
    const terminal = new TerminalStateManager(deps.redis);
    const processing = new ProcessingGuard(deps.redis);

    const pipeline = createPipelineAdapter({
        pipeline: deps.pipeline,
        messages: deps.messages,
    });

    const coordinator = new MemoryTriggerCoordinator({
        lock,
        terminal,
        processing,
        pipeline,
        metrics: deps.metrics,
    });

    const messageCounter = new MessageCounter({
        coordinator,
        redis: deps.redis,
    });

    const sessionEndTrigger = new SessionEndTrigger({
        coordinator,
    });

    return {
        coordinator,
        messageCounter,
        sessionEndTrigger,
        lifecycle: sessionMemoryLifecycle,
        pipeline,
    };
}

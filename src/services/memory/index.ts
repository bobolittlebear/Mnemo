// src/services/memory/index.ts
/**
 * 长期记忆外层组合根：唯一 import memoryPipelineService 之处。
 *
 * 职责：把真实外部服务（redis / 提取管道 / STM获取最近N轮消息）注入 trigger 纯工厂，
 * 组装为单例并对外暴露 chat 服务所需的成员。
 *
 * trigger/ 目录保持纯粹 —— 不引用任何外部服务，全部经此文件注入。
 */
import redisClient from '@/lib/redis';
import memoryPipelineService from '@/services/memory/memoryPipeline.service';
import { STMChatMessageSource } from './chatMessageSource';
import { createTriggerSystem } from './trigger';

const triggerSystem = createTriggerSystem({
    redis: redisClient,
    pipeline: memoryPipelineService,
    messages: new STMChatMessageSource(),
});

export const { coordinator, messageCounter, sessionEndTrigger } = triggerSystem;

export { sessionMemoryLifecycle } from './trigger';

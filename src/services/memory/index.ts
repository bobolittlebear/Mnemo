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
import MemoryPipelineService from '@/services/memory/memoryPipeline.service';
import { createRedisSessionIdentityResolver } from './sessionIdentity.resolver';
import STM from '@/utils/shortTermMemory';
import { RedisInactiveSessionStore } from './inactiveSessionStore';
import { STMChatMessageSource } from './chatMessageSource';
import { createTriggerSystem } from './trigger';
import { SessionTimeoutScanner } from './trigger/sessionTimeoutScanner';
import { validateConfigInvariants } from './trigger/memoryTriggerConfig';
import { ForgetScanner } from './trigger/forgetScanner';
import { runForgetScan, scheduleDailyAt } from './forget.service';

// 应用启动期校验触发器配置不变式（§7.2 / O4）：防止 llmTimeoutMaxMs 上调后 processing TTL 不足引发双重提取。
validateConfigInvariants();

const sessionIdentityResolver = createRedisSessionIdentityResolver(redisClient);

const memoryPipelineService = new MemoryPipelineService(
    sessionIdentityResolver,
);

const triggerSystem = createTriggerSystem({
    redis: redisClient,
    pipeline: memoryPipelineService,
    messages: new STMChatMessageSource(),
    cleanup: (sid: string) => STM.clearSession(sid),
});

export const { coordinator, messageCounter, sessionEndTrigger } = triggerSystem;

// L2 超时触发：组合根注入 coordinator + sessionStore，启动后台定时扫描
const sessionTimeoutScanner = new SessionTimeoutScanner({
    coordinator,
    sessionStore: new RedisInactiveSessionStore(),
    resolver: sessionIdentityResolver,
});
sessionTimeoutScanner.start();
export { sessionTimeoutScanner };

// 遗忘扫描：每天 03:00 自动软删过期记忆（存量初始化 backfill 是扫描第一步）。
// 注入扫描与调度实现，保持 trigger/ 纯粹。
const forgetScanner = new ForgetScanner({
    scan: () => runForgetScan({ dryRun: false }),
    schedule: scheduleDailyAt,
});
forgetScanner.start();
export { forgetScanner };

export { sessionMemoryLifecycle } from './trigger';
export { memoryPipelineService };
export {
    runForgetScan,
    backfillLastSignificantAt,
    scheduleDailyAt,
} from './forget.service';

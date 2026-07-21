import type { RedisClientType } from 'redis';
import { memoryTriggerConfig } from './memoryTriggerConfig';
import { sessionTriggerKeys } from './triggerKeys';

/**
 * TriggerLayer 触发层标识
 * - explicit 显式触发: 主动调用 API 结束会话 / prompt中有结束意图
 * - timeout 超时触发: redis sessionId ttl过期
 * - threshold 兜底触发/阈值触发: 每日定时任务增量扫描提取、会话消息累增20轮
 */
export type TriggerLayer = 'explicit' | 'timeout' | 'threshold';

export const PROCESSING_TTL_MS = memoryTriggerConfig.processingTtlMs;

export class ProcessingGuard {
    constructor(private redis: RedisClientType) {}

    static getKey(sessionId: string): string {
        return sessionTriggerKeys(sessionId).processing;
    }

    async trySet(sessionId: string, layer: TriggerLayer): Promise<boolean> {
        const result = await this.redis.set(
            ProcessingGuard.getKey(sessionId),
            layer,
            {
                NX: true,
                PX: PROCESSING_TTL_MS,
            },
        );
        return result === 'OK';
    }

    async clear(sessionId: string): Promise<void> {
        await this.redis.del(ProcessingGuard.getKey(sessionId));
    }

    async current(sessionId: string): Promise<TriggerLayer | null> {
        const value = await this.redis.get(ProcessingGuard.getKey(sessionId));
        if (
            value === 'explicit' ||
            value === 'timeout' ||
            value === 'threshold'
        ) {
            return value;
        }
        return null;
    }
}

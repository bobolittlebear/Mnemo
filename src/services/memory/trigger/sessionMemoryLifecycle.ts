import { createLogger } from '@/lib/logger';
import redisClient from '@/lib/redis';
import {
    memoryTriggerConfig,
    validateConfigInvariants,
} from './memoryTriggerConfig';
import { sessionTriggerKeys } from './triggerKeys';

const log = createLogger('ltm');

// 应用启动期校验触发器配置不变式（§7.2 / O4）：防止 llmTimeoutMaxMs 上调后 processing TTL 不足引发双重提取。
validateConfigInvariants();

export interface RedisClient {
    get(key: string): Promise<string | null>;
    set(
        key: string,
        value: string,
        mode?: string,
        ttlSec?: number,
    ): Promise<unknown>;
    unlink(...keys: string[]): Promise<number>;
    del(...keys: string[]): Promise<number>;
}

interface SessionMemoryLifecycleDeps {
    redis: RedisClient;
}

class SessionMemoryLifecycle {
    constructor(private readonly deps: SessionMemoryLifecycleDeps) {}

    async destroy(sessionId: string): Promise<void> {
        const k = sessionTriggerKeys(sessionId);
        const keys = [
            k.lock,
            k.extracted,
            k.processing,
            k.msgCount,
            k.lastActiveAt,
        ];
        await this.unlink(keys);
        log.info('session memory destroyed', {
            sessionId,
            keyCount: keys.length,
        });
    }

    async resetForContinuation(sessionId: string): Promise<boolean> {
        const k = sessionTriggerKeys(sessionId);
        const extracted = await this.deps.redis.get(k.extracted);
        if (!extracted) return false;

        const keys = [k.extracted, k.processing, k.msgCount, k.lastActiveAt];
        await this.unlink(keys);
        log.info('session memory reset for continuation', { sessionId });
        return true;
    }

    /**
     * 更新会话最后活跃时间（消息落库时刻的毫秒时间戳）。
     * 为 L2 超时静默触发器提供数据源：扫描器据此发现超时会话。
     * 仅在消息落库时调用，TTL 跟随 Session（extractedTtlSec）。
     * 失败仅记录日志，不抛出 —— 活跃时间缺失仅影响 L2 扫描精度，不得阻塞落库主流程。
     */
    async touch(sessionId: string): Promise<void> {
        try {
            const k = sessionTriggerKeys(sessionId);
            await this.deps.redis.set(
                k.lastActiveAt,
                String(Date.now()),
                'EX',
                memoryTriggerConfig.extractedTtlSec,
            );
        } catch (err) {
            log.warn('touch last_active_at failed', { sessionId, error: err });
        }
    }

    /**
     * 读取会话最后活跃时间（毫秒时间戳）。
     * @returns 毫秒时间戳；key 不存在或值非法时返回 null
     */
    async getLastActiveAt(sessionId: string): Promise<number | null> {
        try {
            const k = sessionTriggerKeys(sessionId);
            const raw = await this.deps.redis.get(k.lastActiveAt);
            if (!raw) return null;
            const ts = Number(raw);
            return Number.isFinite(ts) ? ts : null;
        } catch (err) {
            log.warn('get last_active_at failed', { sessionId, error: err });
            return null;
        }
    }

    private async unlink(keys: string[]): Promise<void> {
        try {
            await this.deps.redis.unlink(...keys);
        } catch (err) {
            if (
                err instanceof Error &&
                /unknown command|ERR unknown/i.test(err.message)
            ) {
                await this.deps.redis.del(...keys);
                return;
            }
            throw err;
        }
    }
}

export default new SessionMemoryLifecycle({
    redis: redisClient as unknown as RedisClient,
});

export const createSessionMemoryLifecycle = (
    deps: SessionMemoryLifecycleDeps,
) => new SessionMemoryLifecycle(deps);

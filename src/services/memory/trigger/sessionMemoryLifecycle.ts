import { createLogger } from '@/lib/logger';
import redisClient from '@/lib/redis';
import { validateConfigInvariants } from './memoryTriggerConfig';
import { sessionTriggerKeys } from './triggerKeys';

const log = createLogger('ltm');

// 应用启动期校验触发器配置不变式（§7.2 / O4）：防止 llmTimeoutMaxMs 上调后 processing TTL 不足引发双重提取。
validateConfigInvariants();

export interface RedisClient {
    get(key: string): Promise<string | null>;
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
        const keys = [k.lock, k.extracted, k.processing, k.cursor, k.msgCount];
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

        const keys = [k.extracted, k.processing, k.cursor, k.msgCount];
        await this.unlink(keys);
        log.info('session memory reset for continuation', { sessionId });
        return true;
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

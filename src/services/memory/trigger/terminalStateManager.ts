import type { RedisClientType } from 'redis';

const DEFAULT_SESSION_TTL_SEC = 86_400;

/**
 * TSM 终态标记管理器
 * 管理特定 sessionId 是否已经结束记忆提取并归档
 */
export class TerminalStateManager {
    constructor(private redis: RedisClientType) {
        this.redis = redis;
    }

    getKey(sessionId: string): string {
        return `memory:session:${sessionId}:extracted`;
    }

    async isExtracted(sessionId: string): Promise<boolean> {
        const key = this.getKey(sessionId);
        const value = await this.redis.get(key);
        return value === '1';
    }

    async markExtracted(
        sessionId: string,
        sessionTtlSec?: number,
    ): Promise<void> {
        const key = this.getKey(sessionId);
        const ttl = sessionTtlSec ?? DEFAULT_SESSION_TTL_SEC;
        await this.redis.set(key, '1', { EX: ttl });
    }
}

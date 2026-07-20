import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedisClientType } from 'redis';
import { TerminalStateManager } from '@/services/memory/trigger/TerminalStateManager';

interface MockRedis {
    store: Map<string, { value: string; ex: number }>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
}

function createMockRedis(): MockRedis {
    const store = new Map<string, { value: string; ex: number }>();
    return {
        store,
        get: vi.fn((key: string) => {
            const entry = store.get(key);
            return entry ? entry.value : null;
        }),
        set: vi.fn((key: string, value: string, opts: { EX: number }) => {
            store.set(key, { value, ex: opts.EX });
            return 'OK';
        }),
    };
}

describe('TerminalStateManager', () => {
    let manager: TerminalStateManager;
    let redis: MockRedis;
    const sessionId = 'test-session-id';
    const expectedKey = `memory:session:${sessionId}:extracted`;

    beforeEach(() => {
        redis = createMockRedis();
        manager = new TerminalStateManager(redis as unknown as RedisClientType);
    });

    describe('getKey', () => {
        it('返回正确的 key 格式', () => {
            expect(manager.getKey(sessionId)).toBe(expectedKey);
        });
    });

    describe('isExtracted', () => {
        it('未写入时返回 false', async () => {
            const result = await manager.isExtracted(sessionId);
            expect(result).toBe(false);
            expect(redis.get).toHaveBeenCalledWith(expectedKey);
        });

        it('写入后返回 true', async () => {
            await manager.markExtracted(sessionId);
            const result = await manager.isExtracted(sessionId);
            expect(result).toBe(true);
        });

        it('值为非 "1" 时返回 false', async () => {
            redis.store.set(expectedKey, { value: '0', ex: 86400 });
            const result = await manager.isExtracted(sessionId);
            expect(result).toBe(false);
        });
    });

    describe('markExtracted', () => {
        it('写入后 isExtracted 返回 true', async () => {
            await manager.markExtracted(sessionId);
            const value = redis.store.get(expectedKey);
            expect(value!.value).toBe('1');
        });

        it('默认 TTL 为 86400', async () => {
            await manager.markExtracted(sessionId);
            expect(redis.set).toHaveBeenCalledWith(expectedKey, '1', { EX: 86400 });
        });

        it('自定义 TTL 正确传递', async () => {
            await manager.markExtracted(sessionId, 3600);
            expect(redis.set).toHaveBeenCalledWith(expectedKey, '1', { EX: 3600 });
        });

        it('多次 markExtracted 不报错，值仍为 "1"', async () => {
            await manager.markExtracted(sessionId);
            await manager.markExtracted(sessionId);
            await manager.markExtracted(sessionId);
            const value = redis.store.get(expectedKey);
            expect(value!.value).toBe('1');
        });

        it('多次 markExtracted 最后一次 TTL 覆盖前值', async () => {
            await manager.markExtracted(sessionId, 3600);
            await manager.markExtracted(sessionId, 7200);
            expect(redis.set).toHaveBeenLastCalledWith(expectedKey, '1', { EX: 7200 });
        });
    });
});

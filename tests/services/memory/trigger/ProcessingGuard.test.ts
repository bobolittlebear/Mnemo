import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedisClientType } from 'redis';
import {
    ProcessingGuard,
    PROCESSING_TTL_MS,
} from '@/services/memory/trigger/processingGuard';

interface MockRedis {
    store: Map<string, { value: string; px: number }>;
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
}

function createMockRedis(): MockRedis {
    const store = new Map<string, { value: string; px: number }>();
    return {
        store,
        set: vi.fn(
            (key: string, value: string, opts: { NX: true; PX: number }) => {
                if (store.has(key)) return null;
                store.set(key, { value, px: opts.PX });
                return 'OK';
            },
        ),
        get: vi.fn((key: string) => {
            const entry = store.get(key);
            return entry ? entry.value : null;
        }),
        del: vi.fn((key: string) => {
            store.delete(key);
            return 1;
        }),
    };
}

describe('ProcessingGuard', () => {
    let guard: ProcessingGuard;
    let redis: MockRedis;

    beforeEach(() => {
        redis = createMockRedis();
        guard = new ProcessingGuard(redis as unknown as RedisClientType);
    });

    describe('getKey', () => {
        it('返回正确的 key 格式', () => {
            const key = ProcessingGuard.getKey('session-123');
            expect(key).toBe('memory:session:session-123:processing');
        });
    });

    describe('trySet', () => {
        it('首次设置返回 true', async () => {
            const result = await guard.trySet('session-1', 'explicit');
            expect(result).toBe(true);
        });

        it('key 已存在时返回 false', async () => {
            await guard.trySet('session-1', 'explicit');
            const result = await guard.trySet('session-1', 'timeout');
            expect(result).toBe(false);
        });

        it('TTL 参数正确传递为 PROCESSING_TTL_MS', async () => {
            await guard.trySet('session-1', 'threshold');
            expect(redis.set).toHaveBeenCalledWith(
                'memory:session:session-1:processing',
                'threshold',
                {
                    NX: true,
                    PX: PROCESSING_TTL_MS,
                },
            );
            expect(PROCESSING_TTL_MS).toBe(300_000);
        });

        it('redis.set 异常时向上抛出', async () => {
            redis.set.mockRejectedValueOnce(new Error('连接失败'));
            await expect(guard.trySet('session-1', 'explicit')).rejects.toThrow(
                '连接失败',
            );
        });
    });

    describe('clear', () => {
        it('清除后 trySet 可再次成功', async () => {
            await guard.trySet('session-1', 'explicit');
            await guard.clear('session-1');
            const result = await guard.trySet('session-1', 'timeout');
            expect(result).toBe(true);
        });

        it('清除不存在的 key 不报错', async () => {
            await expect(guard.clear('nonexistent')).resolves.toBeUndefined();
        });

        it('redis.del 异常时向上抛出', async () => {
            redis.del.mockRejectedValueOnce(new Error('连接失败'));
            await expect(guard.clear('session-1')).rejects.toThrow('连接失败');
        });
    });

    describe('current', () => {
        it('返回当前 TriggerLayer', async () => {
            await guard.trySet('session-1', 'explicit');
            const layer = await guard.current('session-1');
            expect(layer).toBe('explicit');
        });

        it('未设置时返回 null', async () => {
            const layer = await guard.current('nonexistent');
            expect(layer).toBeNull();
        });

        it('返回 timeout 类型', async () => {
            await guard.trySet('session-1', 'timeout');
            const layer = await guard.current('session-1');
            expect(layer).toBe('timeout');
        });

        it('返回 threshold 类型', async () => {
            await guard.trySet('session-1', 'threshold');
            const layer = await guard.current('session-1');
            expect(layer).toBe('threshold');
        });

        it('redis.get 异常时向上抛出', async () => {
            redis.get.mockRejectedValueOnce(new Error('连接失败'));
            await expect(guard.current('session-1')).rejects.toThrow(
                '连接失败',
            );
        });
    });

    describe('并发', () => {
        it('并发 trySet 只有一个成功', async () => {
            const results = await Promise.all([
                guard.trySet('concurrent', 'explicit'),
                guard.trySet('concurrent', 'timeout'),
                guard.trySet('concurrent', 'threshold'),
            ]);
            const successCount = results.filter(Boolean).length;
            expect(successCount).toBe(1);
        });
    });
});

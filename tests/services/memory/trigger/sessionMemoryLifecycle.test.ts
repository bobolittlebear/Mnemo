import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('@/lib/redis', () => ({
    default: { get: vi.fn(), unlink: vi.fn(), del: vi.fn() },
}));

import { createSessionMemoryLifecycle, type RedisClient } from '@/services/memory/trigger/sessionMemoryLifecycle';
import { sessionTriggerKeys } from '@/services/memory/trigger/triggerKeys';

const SID = 'sess-123';

const expectedKeys = sessionTriggerKeys(SID);

function makeRedis(): RedisClient & { _store: Map<string, string> } {
    const store = new Map<string, string>();
    const redis = {
        _store: store,
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        unlink: vi.fn(async (...keys: string[]) => {
            keys.forEach((k) => store.delete(k));
            return keys.length;
        }),
        del: vi.fn(async (...keys: string[]) => {
            keys.forEach((k) => store.delete(k));
            return keys.length;
        }),
    };
    return redis as unknown as RedisClient & { _store: Map<string, string> };
}

describe('SessionMemoryLifecycle', () => {
    let redis: ReturnType<typeof makeRedis>;
    let service: ReturnType<typeof createSessionMemoryLifecycle>;

    beforeEach(() => {
        redis = makeRedis();
        service = createSessionMemoryLifecycle({ redis });
    });

    describe('destroy', () => {
        it('清空全部 5 个 key', async () => {
            redis._store.set(expectedKeys.lock, '1');
            redis._store.set(expectedKeys.extracted, '1');
            redis._store.set(expectedKeys.processing, '1');
            redis._store.set(expectedKeys.cursor, 'msg-9');
            redis._store.set(expectedKeys.msgCount, '7');

            await service.destroy(SID);

            expect(redis.unlink).toHaveBeenCalledTimes(1);
            const args = (redis.unlink as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(args).toEqual([
                expectedKeys.lock,
                expectedKeys.extracted,
                expectedKeys.processing,
                expectedKeys.cursor,
                expectedKeys.msgCount,
            ]);
            for (const k of Object.values(expectedKeys)) {
                expect(redis._store.has(k)).toBe(false);
            }
        });

        it('unlink 不支持时退化为 del', async () => {
            (redis.unlink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error('ERR unknown command: UNLINK'),
            );
            await service.destroy(SID);
            expect(redis.del).toHaveBeenCalledTimes(1);
            expect((redis.del as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
                expectedKeys.lock,
                expectedKeys.extracted,
                expectedKeys.processing,
                expectedKeys.cursor,
                expectedKeys.msgCount,
            ]);
        });

        it('无 key 时仍调用 unlink 一次（幂等）', async () => {
            await service.destroy(SID);
            expect(redis.unlink).toHaveBeenCalledTimes(1);
        });
    });

    describe('resetForContinuation', () => {
        it('extracted 不存在 → 返回 false 且不调用 unlink', async () => {
            const result = await service.resetForContinuation(SID);
            expect(result).toBe(false);
            expect(redis.unlink).not.toHaveBeenCalled();
        });

        it('extracted 存在 → 返回 true 且清状态 key（不含 lock）', async () => {
            redis._store.set(expectedKeys.extracted, '1');
            redis._store.set(expectedKeys.processing, '1');
            redis._store.set(expectedKeys.cursor, 'msg-9');
            redis._store.set(expectedKeys.msgCount, '7');
            redis._store.set(expectedKeys.lock, '1');

            const result = await service.resetForContinuation(SID);

            expect(result).toBe(true);
            expect(redis.unlink).toHaveBeenCalledTimes(1);
            const args = (redis.unlink as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(args).toEqual([
                expectedKeys.extracted,
                expectedKeys.processing,
                expectedKeys.cursor,
                expectedKeys.msgCount,
            ]);
            expect(args).not.toContain(expectedKeys.lock);
        });

        it('重置后再次 get(extracted) 为 null（终态已清，后续 L3 可重新触发）', async () => {
            redis._store.set(expectedKeys.extracted, '1');
            redis._store.set(expectedKeys.cursor, 'msg-9');
            redis._store.set(expectedKeys.msgCount, '7');

            await service.resetForContinuation(SID);

            expect(await redis.get(expectedKeys.extracted)).toBeNull();
            expect(await redis.get(expectedKeys.cursor)).toBeNull();
            expect(await redis.get(expectedKeys.msgCount)).toBeNull();
        });
    });
});

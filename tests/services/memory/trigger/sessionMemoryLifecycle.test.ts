import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('@/lib/redis', () => ({
    default: { get: vi.fn(), set: vi.fn(), unlink: vi.fn(), del: vi.fn() },
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
        set: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
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
        it('清空全部 5 个 key（含 lastActiveAt）', async () => {
            redis._store.set(expectedKeys.lock, '1');
            redis._store.set(expectedKeys.extracted, '1');
            redis._store.set(expectedKeys.processing, '1');
            redis._store.set(expectedKeys.msgCount, '7');
            redis._store.set(expectedKeys.lastActiveAt, String(Date.now()));

            await service.destroy(SID);

            expect(redis.unlink).toHaveBeenCalledTimes(1);
            const args = (redis.unlink as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(args).toEqual([
                expectedKeys.lock,
                expectedKeys.extracted,
                expectedKeys.processing,
                expectedKeys.msgCount,
                expectedKeys.lastActiveAt,
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
                expectedKeys.msgCount,
                expectedKeys.lastActiveAt,
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

        it('extracted 存在 → 返回 true 且清状态 key（不含 lock，含 lastActiveAt）', async () => {
            redis._store.set(expectedKeys.extracted, '1');
            redis._store.set(expectedKeys.processing, '1');
            redis._store.set(expectedKeys.msgCount, '7');
            redis._store.set(expectedKeys.lastActiveAt, String(Date.now()));
            redis._store.set(expectedKeys.lock, '1');

            const result = await service.resetForContinuation(SID);

            expect(result).toBe(true);
            expect(redis.unlink).toHaveBeenCalledTimes(1);
            const args = (redis.unlink as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(args).toEqual([
                expectedKeys.extracted,
                expectedKeys.processing,
                expectedKeys.msgCount,
                expectedKeys.lastActiveAt,
            ]);
            expect(args).not.toContain(expectedKeys.lock);
        });

        it('重置后再次 get(extracted) 为 null（终态已清，后续 L3 可重新触发）', async () => {
            redis._store.set(expectedKeys.extracted, '1');
            redis._store.set(expectedKeys.msgCount, '7');
            redis._store.set(expectedKeys.lastActiveAt, String(Date.now()));

            await service.resetForContinuation(SID);

            expect(await redis.get(expectedKeys.extracted)).toBeNull();
            expect(await redis.get(expectedKeys.msgCount)).toBeNull();
            expect(await redis.get(expectedKeys.lastActiveAt)).toBeNull();
        });
    });

    describe('touch / getLastActiveAt', () => {
        it('touch 后 getLastActiveAt 返回与 Date.now() 误差 5s 内的毫秒时间戳', async () => {
            const before = Date.now();
            await service.touch(SID);
            const after = Date.now();

            const ts = await service.getLastActiveAt(SID);

            expect(ts).not.toBeNull();
            expect(ts! >= before).toBe(true);
            expect(ts! <= after).toBe(true);
        });

        it('touch 以 EX + extractedTtlSec 写入 lastActiveAt key', async () => {
            await service.touch(SID);

            expect(redis.set).toHaveBeenCalledTimes(1);
            const args = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
            expect(args[0]).toBe(expectedKeys.lastActiveAt);
            expect(args[2]).toBe('EX');
            expect(args[3]).toBe(86400);
            // 值为可解析为数字的毫秒时间戳字符串
            expect(Number.isFinite(Number(args[1]))).toBe(true);
        });

        it('key 不存在时 getLastActiveAt 返回 null', async () => {
            const ts = await service.getLastActiveAt(SID);
            expect(ts).toBeNull();
        });

        it('touch 失败不抛出（仅 log）', async () => {
            (redis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error('redis connection refused'),
            );
            await expect(service.touch(SID)).resolves.toBeUndefined();
        });

        it('destroy 后 getLastActiveAt 为 null', async () => {
            await service.touch(SID);
            expect(await service.getLastActiveAt(SID)).not.toBeNull();

            await service.destroy(SID);

            expect(await service.getLastActiveAt(SID)).toBeNull();
        });

        it('resetForContinuation 后 getLastActiveAt 为 null', async () => {
            await service.touch(SID);
            redis._store.set(expectedKeys.extracted, '1');

            await service.resetForContinuation(SID);

            expect(await service.getLastActiveAt(SID)).toBeNull();
        });
    });
});

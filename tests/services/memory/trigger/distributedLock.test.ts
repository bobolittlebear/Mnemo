import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedisClientType } from 'redis';
import {
    DistributedLock,
    LOCK_TTL_MS,
} from '@/services/memory/trigger/distributedLock';

interface MockRedis {
    store: Map<string, { value: string; px: number }>;
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
}

function createMockRedis(): MockRedis {
    const store = new Map<string, { value: string; px: number }>();
    return {
        store,
        set: vi.fn(
            (_key: string, value: string, opts: { NX: true; PX: number }) => {
                if (store.has(_key)) return null;
                store.set(_key, { value, px: opts.PX });
                return 'OK';
            },
        ),
        eval: vi.fn(
            (
                _script: string,
                opts: { keys: string[]; arguments: string[] },
            ) => {
                const key = opts.keys[0]!;
                const token = opts.arguments[0];
                const entry = store.get(key);
                if (!entry || entry.value !== token) return 0;
                store.delete(key);
                return 1;
            },
        ),
    };
}

describe('DistributedLock', () => {
    let lock: DistributedLock;
    let redis: MockRedis;

    beforeEach(() => {
        redis = createMockRedis();
        lock = new DistributedLock(redis as unknown as RedisClientType);
    });

    describe('acquire', () => {
        it('成功获取锁时返回 token', async () => {
            const token = await lock.acquire('test:lock');
            expect(token).toBeTypeOf('string');
            expect(redis.set).toHaveBeenCalledWith('test:lock', token, {
                NX: true,
                PX: LOCK_TTL_MS,
            });
        });

        it('锁已被持有时返回 null', async () => {
            await lock.acquire('test:lock');
            const second = await lock.acquire('test:lock');
            expect(second).toBeNull();
        });

        it('redis.set 异常时向上抛出', async () => {
            redis.set.mockRejectedValueOnce(new Error('connection refused'));
            await expect(lock.acquire('test:lock')).rejects.toThrow(
                'connection refused',
            );
        });
    });

    describe('release', () => {
        it('token 匹配时释放锁并返回 true', async () => {
            const token = await lock.acquire('test:lock');
            const released = await lock.release('test:lock', token!);
            expect(released).toBe(true);
        });

        it('token 不匹配时返回 false 且不删除', async () => {
            await lock.acquire('test:lock');
            const released = await lock.release('test:lock', 'wrong-token');
            expect(released).toBe(false);
            expect(redis.store.has('test:lock')).toBe(true);
        });

        it('锁不存在时返回 false', async () => {
            const released = await lock.release('nonexistent', 'some-token');
            expect(released).toBe(false);
        });

        it('释放后可以重新获取', async () => {
            const token = await lock.acquire('test:lock');
            await lock.release('test:lock', token!);
            const newToken = await lock.acquire('test:lock');
            expect(newToken).toBeTypeOf('string');
            expect(newToken).not.toBe(token);
        });

        it('redis.eval 异常时向上抛出', async () => {
            redis.eval.mockRejectedValueOnce(new Error('connection refused'));
            await expect(
                lock.release('test:lock', 'some-token'),
            ).rejects.toThrow('connection refused');
        });

        // P0: TTL 过期后，旧 token 不能释放新持有者的锁
        it('TTL 过期后旧 token 不能释放新持锁者的锁', async () => {
            const tokenA = await lock.acquire('test:lock');
            expect(tokenA).toBeTypeOf('string');

            // 模拟 TTL 过期：Redis 自动删除 key
            redis.store.delete('test:lock');

            // 新客户端获取锁
            const tokenB = await lock.acquire('test:lock');
            expect(tokenB).toBeTypeOf('string');
            expect(tokenB).not.toBe(tokenA);

            // 旧客户端尝试用过期 token 释放 → 必须失败
            const released = await lock.release('test:lock', tokenA!);
            expect(released).toBe(false);
            expect(redis.store.has('test:lock')).toBe(true);
            expect(redis.store.get('test:lock')!.value).toBe(tokenB);
        });
    });

    // P2: 并发竞争
    describe('concurrency', () => {
        it('并发 acquire 只有一个成功', async () => {
            const results = await Promise.all([
                lock.acquire('concurrent:lock'),
                lock.acquire('concurrent:lock'),
                lock.acquire('concurrent:lock'),
            ]);
            const tokens = results.filter((r): r is string => r !== null);
            expect(tokens).toHaveLength(1);
        });

        it('并发 release 不会误删', async () => {
            const token = await lock.acquire('concurrent:lock');

            const results = await Promise.all([
                lock.release('concurrent:lock', token!),
                lock.release('concurrent:lock', token!),
                lock.release('concurrent:lock', 'other'),
            ]);

            // 只有一个成功（原子操作，最多删除一次）
            const successCount = results.filter(Boolean).length;
            expect(successCount).toBe(1);
        });
    });
});

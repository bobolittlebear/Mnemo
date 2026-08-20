import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));
import { RedisClientType } from 'redis';

import {
    MessageCounter,
    type TriggerCoordinator,
    type TriggerResult,
} from '@/services/memory/trigger/messageCounter';
import { sessionTriggerKeys } from '@/services/memory/trigger/triggerKeys';

const completed = (): TriggerResult => ({
    status: 'COMPLETED',
    terminalWritten: false,
});

const skipped = (
    reason: 'LOCK' | 'TERMINAL' | 'PROCESSING',
): TriggerResult => ({
    status: 'SKIPPED',
    reason,
});

function createFakeRedis(): RedisClientType {
    const store = new Map<string, number>();
    const incrBy = vi.fn<(key: string, increment: number) => Promise<number>>(
        async (key, increment) => {
            const next = (store.get(key) ?? 0) + increment;
            store.set(key, next);
            return next;
        },
    );
    const expire = vi.fn<
        (key: string, seconds: number, mode?: string) => Promise<number>
    >(async () => 1);
    const del = vi.fn<(...keys: string[]) => Promise<number>>(async (key) => {
        const had = store.has(key);
        store.delete(key);
        return had ? 1 : 0;
    });
    const decrBy = vi.fn(async (key: string, decrement: number) => {
        const next = (store.get(key) ?? 0) - decrement;
        store.set(key, next);
        return next;
    });

    return { incrBy, expire, del, decrBy } as any;
}

function createCoordinator(
    fn: () => Promise<TriggerResult>,
): TriggerCoordinator {
    return { triggerThreshold: vi.fn(fn) };
}

const KEY = sessionTriggerKeys('s1').msgCount;

describe('MessageCounter', () => {
    let redis: RedisClientType;

    beforeEach(() => {
        redis = createFakeRedis();
    });

    it('未达阈值不触发 triggerThreshold', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        // incrBy 2：2 次后 count=4 < 5，不触发
        for (let i = 0; i < 2; i++) await counter.record('s1');

        expect(coordinator.triggerThreshold).not.toHaveBeenCalled();
    });

    it('达到阈值触发一次 triggerThreshold', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        // incrBy 2：3 次后 count=6 >= 5，触发 1 次
        for (let i = 0; i < 3; i++) await counter.record('s1');

        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
        expect(coordinator.triggerThreshold).toHaveBeenCalledWith('s1');
    });

    it('默认阈值为 20', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({ coordinator, redis });

        // incrBy 2：9 次后 count=18 < 20，不触发
        for (let i = 0; i < 9; i++) await counter.record('s1');
        expect(coordinator.triggerThreshold).not.toHaveBeenCalled();

        // 第 10 次 count=20 >= 20，触发一次
        await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
    });

    it('每次 record 都调用 expire 设置 NX TTL', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        // incrBy 2 后 expire 无条件调用，带 NX 模式（仅在 key 无过期时间时设置）
        await counter.record('s1');
        expect(redis.expire).toHaveBeenCalledWith(
            KEY,
            expect.any(Number),
            'NX',
        );

        await counter.record('s1');
        expect(redis.expire).toHaveBeenCalledTimes(2);
    });

    it('COMPLETED 扣减 msg_count（decrBy threshold）', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        // incrBy 2, threshold=5, COMPLETED → decrBy(5)
        // count: 2,4,6(触发→decrBy 5→1),3,5(触发→decrBy 5→0) → 2 次触发
        for (let i = 0; i < 5; i++) await counter.record('s1');

        expect(redis.decrBy).toHaveBeenCalledWith(KEY, 5);
        expect(redis.decrBy).toHaveBeenCalledTimes(2);
        expect(redis.del).not.toHaveBeenCalled();

        // incrBy 2：上次扣减后 count=0，+2=2 < 5，不再触发
        await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(2);
    });

    it('SKIPPED/TERMINAL 重置 msg_count', async () => {
        const coordinator = createCoordinator(async () => skipped('TERMINAL'));
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        for (let i = 0; i < 5; i++) await counter.record('s1');

        expect(redis.del).toHaveBeenCalledWith(KEY);
    });

    it('SKIPPED/PROCESSING 不重置，下条消息再次触发', async () => {
        const coordinator = createCoordinator(async () =>
            skipped('PROCESSING'),
        );
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        // incrBy 2：count 2,4,6(触发),8(触发),10(触发) → 3 次触发
        for (let i = 0; i < 5; i++) await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(3);
        expect(redis.del).not.toHaveBeenCalled();

        // 第 6 条消息 count=12，再次触发
        await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(4);
    });

    it('SKIPPED/LOCK 不重置', async () => {
        const coordinator = createCoordinator(async () => skipped('LOCK'));
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        for (let i = 0; i < 5; i++) await counter.record('s1');

        expect(redis.del).not.toHaveBeenCalled();
    });

    it('coordinator 抛错时 record 不向外抛', async () => {
        const coordinator = createCoordinator(async () => {
            throw new Error('boom');
        });
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        // incrBy 2：count 2,4,6(触发→抛错),8(触发→抛错),10(触发→抛错) → 3 次触发
        let threw = false;
        try {
            for (let i = 0; i < 5; i++) await counter.record('s1');
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(3);
    });
});

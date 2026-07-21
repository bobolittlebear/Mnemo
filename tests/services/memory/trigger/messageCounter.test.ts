import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import {
    MessageCounter,
    type RedisClient,
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

function createFakeRedis(): RedisClient {
    const store = new Map<string, number>();
    const incr = vi.fn<(key: string) => Promise<number>>(async (key) => {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
    });
    const expire = vi.fn<(key: string, seconds: number) => Promise<number>>(
        async () => 1,
    );
    const del = vi.fn<(...keys: string[]) => Promise<number>>(async (key) => {
        const had = store.has(key);
        store.delete(key);
        return had ? 1 : 0;
    });
    return { incr, expire, del };
}

function createCoordinator(
    fn: () => Promise<TriggerResult>,
): TriggerCoordinator {
    return { triggerThreshold: vi.fn(fn) };
}

const KEY = sessionTriggerKeys('s1').msgCount;

describe('MessageCounter', () => {
    let redis: RedisClient;

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

        for (let i = 0; i < 4; i++) await counter.record('s1');

        expect(coordinator.triggerThreshold).not.toHaveBeenCalled();
    });

    it('达到阈值触发一次 triggerThreshold', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        for (let i = 0; i < 5; i++) await counter.record('s1');

        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
        expect(coordinator.triggerThreshold).toHaveBeenCalledWith('s1');
    });

    it('默认阈值为 20', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({ coordinator, redis });

        for (let i = 0; i < 19; i++) await counter.record('s1');
        expect(coordinator.triggerThreshold).not.toHaveBeenCalled();

        await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
    });

    it('首次 INCR 补 TTL，后续不重复补', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        await counter.record('s1');
        expect(redis.expire).toHaveBeenCalledWith(KEY, 86400);

        await counter.record('s1');
        expect(redis.expire).toHaveBeenCalledTimes(1);
    });

    it('COMPLETED 重置 msg_count', async () => {
        const coordinator = createCoordinator(async () => completed());
        const counter = new MessageCounter({
            coordinator,
            redis,
            threshold: 5,
        });

        for (let i = 0; i < 5; i++) await counter.record('s1');

        expect(redis.del).toHaveBeenCalledWith(KEY);

        // 重置后下一轮从 1 开始，不应再次触发
        await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
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

        for (let i = 0; i < 5; i++) await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
        expect(redis.del).not.toHaveBeenCalled();

        await counter.record('s1');
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(2);
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

        let threw = false;
        try {
            for (let i = 0; i < 5; i++) await counter.record('s1');
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
        expect(coordinator.triggerThreshold).toHaveBeenCalledTimes(1);
    });
});

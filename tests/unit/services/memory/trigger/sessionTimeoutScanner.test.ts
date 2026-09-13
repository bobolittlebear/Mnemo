import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SessionTimeoutScanner } from '@/services/memory/trigger/sessionTimeoutScanner';
import { memoryTriggerConfig } from '@/services/memory/trigger/memoryTriggerConfig';

type TriggerResult =
    | { status: 'COMPLETED'; terminalWritten: boolean }
    | { status: 'SKIPPED'; reason: 'LOCK' | 'TERMINAL' | 'PROCESSING' };

const completed = (terminalWritten: boolean): TriggerResult => ({
    status: 'COMPLETED',
    terminalWritten,
});

const skipped = (
    reason: 'LOCK' | 'TERMINAL' | 'PROCESSING',
): TriggerResult => ({ status: 'SKIPPED', reason });

type EndFn = (
    sessionId: string,
    layer: 'explicit' | 'timeout',
    userId?: string,
) => Promise<TriggerResult>;

function createCoordinator(fn: EndFn) {
    return { executeTerminalTrigger: vi.fn(fn) };
}

function createStore(sids: string[]) {
    return {
        findInactiveSessions: vi.fn(async () => sids),
    };
}

function createResolver(opts?: { resolveBatch?: boolean }) {
    if (opts?.resolveBatch === false) {
        return {
            resolve: vi.fn(async () => null),
        };
    }
    // Default: has resolveBatch
    return {
        resolve: vi.fn(async () => null),
        resolveBatch: vi.fn(
            async (ids: string[]) =>
                new Map(ids.map((id) => [id, 'u_' + id])),
        ),
    };
}

describe('SessionTimeoutScanner', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('findInactiveSessions 返回 2 个 sid：各调用一次 executeTerminalTrigger，参数为 (sid, timeout, undefined)', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1', 'sid2']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await scanner.scanOnce();

        expect(store.findInactiveSessions).toHaveBeenCalledTimes(1);
        expect(store.findInactiveSessions).toHaveBeenCalledWith(
            memoryTriggerConfig.l2TimeoutSec,
        );
        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(2);
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            1,
            'sid1',
            'timeout',
            undefined,
        );
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            2,
            'sid2',
            'timeout',
            undefined,
        );
    });

    it('findInactiveSessions 返回空数组：executeTerminalTrigger 不被调用', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore([]);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await scanner.scanOnce();

        expect(coordinator.executeTerminalTrigger).not.toHaveBeenCalled();
    });

    it('某 sid 返回 SKIPPED/TERMINAL：不抛错，其余 sid 仍被处理', async () => {
        const coordinator = createCoordinator(async (sid) =>
            sid === 'sid1' ? skipped('TERMINAL') : completed(true),
        );
        const store = createStore(['sid1', 'sid2']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await expect(scanner.scanOnce()).resolves.toBeUndefined();

        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(2);
    });

    it('某 sid 的 executeTerminalTrigger 抛错：被 catch，scanOnce 不抛，其余 sid 仍处理', async () => {
        const coordinator = createCoordinator(async (sid) => {
            if (sid === 'sid1') throw new Error('提取失败');
            return completed(true);
        });
        const store = createStore(['sid1', 'sid2']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await expect(scanner.scanOnce()).resolves.toBeUndefined();

        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(2);
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            2,
            'sid2',
            'timeout',
            undefined,
        );
    });

    it('start() 启动周期扫描：按 scanIntervalSec 间隔触发 scanOnce', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
            scanIntervalSec: 100,
        });
        const spy = vi.spyOn(scanner, 'scanOnce');

        scanner.start();
        // 第一个周期
        await vi.advanceTimersByTimeAsync(100 * 1000);
        // 第二个周期
        await vi.advanceTimersByTimeAsync(100 * 1000);

        expect(spy).toHaveBeenCalledTimes(2);
        scanner.stop();
    });

    it('stop() 清除定时器：不再触发 scanOnce', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
            scanIntervalSec: 100,
        });
        const spy = vi.spyOn(scanner, 'scanOnce');

        scanner.start();
        scanner.stop();
        await vi.advanceTimersByTimeAsync(100 * 1000);

        expect(spy).not.toHaveBeenCalled();
    });

    it('自定义 timeoutSec 透传给 findInactiveSessions', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore([]);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
            timeoutSec: 60,
        });

        await scanner.scanOnce();

        expect(store.findInactiveSessions).toHaveBeenCalledWith(60);
    });

    // ── 整轮 guard（runGuardedTask） ──

    it('整轮依赖失败（不可重试错误）：scanOnce 不抛，且不触发终端', async () => {
        const err: any = new Error('bad request');
        err.status = 400; // 不可重试 → withRetry 立即抛出，不进入退避等待
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1', 'sid2']);
        store.findInactiveSessions.mockRejectedValue(err);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await expect(scanner.scanOnce()).resolves.toBeUndefined();

        expect(store.findInactiveSessions).toHaveBeenCalledTimes(1);
        expect(coordinator.executeTerminalTrigger).not.toHaveBeenCalled();
    });

    it('瞬态失败后重试成功：整轮重试生效，照常触发终端', async () => {
        vi.useRealTimers(); // 放行 withRetry 的真实退避（默认 ≤2s）
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1']);
        store.findInactiveSessions
            .mockRejectedValueOnce(new Error('MongoPoolClearedError'))
            .mockResolvedValue(['sid1']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await scanner.scanOnce();

        expect(store.findInactiveSessions).toHaveBeenCalledTimes(2);
        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(1);
    });

    // ── M4: batch resolve tests ──

    it('resolveBatch 仅触发 1 次，coordinator 第三参数为对应 userId', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1', 'sid2']);
        const resolver = createResolver(); // has resolveBatch
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await scanner.scanOnce();

        expect(resolver.resolveBatch).toHaveBeenCalledTimes(1);
        expect(resolver.resolveBatch).toHaveBeenCalledWith(['sid1', 'sid2']);
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            1,
            'sid1',
            'timeout',
            'u_sid1',
        );
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            2,
            'sid2',
            'timeout',
            'u_sid2',
        );
    });

    it('resolver 无 resolveBatch 时降级：第三参数全为 undefined', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1', 'sid2']);
        const resolver = createResolver({ resolveBatch: false });
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            resolver,
        });

        await scanner.scanOnce();

        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            1,
            'sid1',
            'timeout',
            undefined,
        );
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            2,
            'sid2',
            'timeout',
            undefined,
        );
    });
});

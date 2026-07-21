import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SessionTimeoutScanner } from '@/services/memory/trigger/sessionTimeoutScanner';

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
) => Promise<TriggerResult>;

function createCoordinator(fn: EndFn) {
    return { executeTerminalTrigger: vi.fn(fn) };
}

function createStore(sids: string[]) {
    return {
        findInactiveSessions: vi.fn(async () => sids),
    };
}

describe('SessionTimeoutScanner', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('findInactiveSessions 返回 2 个 sid：各调用一次 executeTerminalTrigger，参数为 (sid, timeout)', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1', 'sid2']);
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
        });

        await scanner.scanOnce();

        expect(store.findInactiveSessions).toHaveBeenCalledTimes(1);
        expect(store.findInactiveSessions).toHaveBeenCalledWith(1800);
        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(2);
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            1,
            'sid1',
            'timeout',
        );
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            2,
            'sid2',
            'timeout',
        );
    });

    it('findInactiveSessions 返回空数组：executeTerminalTrigger 不被调用', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore([]);
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
        });

        await scanner.scanOnce();

        expect(coordinator.executeTerminalTrigger).not.toHaveBeenCalled();
    });

    it('某 sid 返回 SKIPPED/TERMINAL：不抛错，其余 sid 仍被处理', async () => {
        const coordinator = createCoordinator(async (sid) =>
            sid === 'sid1' ? skipped('TERMINAL') : completed(true),
        );
        const store = createStore(['sid1', 'sid2']);
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
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
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
        });

        await expect(scanner.scanOnce()).resolves.toBeUndefined();

        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(2);
        expect(coordinator.executeTerminalTrigger).toHaveBeenNthCalledWith(
            2,
            'sid2',
            'timeout',
        );
    });

    it('start() 启动周期扫描：按 scanIntervalSec 间隔触发 scanOnce', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const store = createStore(['sid1']);
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
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
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
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
        const scanner = new SessionTimeoutScanner({
            coordinator,
            sessionStore: store,
            timeoutSec: 60,
        });

        await scanner.scanOnce();

        expect(store.findInactiveSessions).toHaveBeenCalledWith(60);
    });
});

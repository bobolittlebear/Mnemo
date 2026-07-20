import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryTriggerCoordinator } from '@/services/memory/trigger/memoryTriggerCoordinator';
import type { CoordinatorDeps } from '@/services/memory/trigger/memoryTriggerCoordinator';

function makeMocks() {
    const lock = {
        acquire: vi.fn().mockResolvedValue('token-1'),
        release: vi.fn().mockResolvedValue(true),
    };
    const terminal = {
        isExtracted: vi.fn().mockResolvedValue(false),
        markExtracted: vi.fn().mockResolvedValue(undefined),
    };
    const processing = {
        trySet: vi.fn().mockResolvedValue(true),
        clear: vi.fn().mockResolvedValue(undefined),
        current: vi.fn().mockResolvedValue(null),
    };
    const pipeline = { run: vi.fn().mockResolvedValue(undefined) };
    const metrics = { count: vi.fn() };
    return { lock, terminal, processing, pipeline, metrics };
}

function makeCoordinator(mocks: ReturnType<typeof makeMocks>) {
    const deps: CoordinatorDeps = {
        lock: mocks.lock as any,
        terminal: mocks.terminal as any,
        processing: mocks.processing as any,
        pipeline: mocks.pipeline,
        metrics: mocks.metrics,
    };
    return new MemoryTriggerCoordinator(deps);
}

describe('MemoryTriggerCoordinator', () => {
    let mocks: ReturnType<typeof makeMocks>;
    let coordinator: MemoryTriggerCoordinator;

    beforeEach(() => {
        mocks = makeMocks();
        coordinator = makeCoordinator(mocks);
    });

    describe('triggerThreshold (L3)', () => {
        it('正常完成：不写终态，清 processing，返回 COMPLETED terminalWritten=false', async () => {
            const result = await coordinator.triggerThreshold('s1');

            expect(result).toEqual({
                status: 'COMPLETED',
                terminalWritten: false,
            });
            expect(mocks.terminal.markExtracted).not.toHaveBeenCalled();
            expect(mocks.pipeline.run).toHaveBeenCalledWith('s1');
            expect(mocks.processing.clear).toHaveBeenCalled();
            // Phase 1 acquire + Phase 3 acquire
            expect(mocks.lock.acquire).toHaveBeenCalledTimes(2);
            expect(mocks.lock.release).toHaveBeenCalledTimes(2);
        });
    });

    describe('executeTerminalTrigger (L1)', () => {
        it('正常完成：写终态 1 次，返回 COMPLETED terminalWritten=true', async () => {
            const result = await coordinator.executeTerminalTrigger(
                's1',
                'explicit',
            );

            expect(result).toEqual({
                status: 'COMPLETED',
                terminalWritten: true,
            });
            expect(mocks.terminal.markExtracted).toHaveBeenCalledTimes(1);
            expect(mocks.terminal.markExtracted).toHaveBeenCalledWith('s1');
            expect(mocks.pipeline.run).toHaveBeenCalledWith('s1');
            expect(mocks.processing.clear).toHaveBeenCalled();
        });

        it('L2 timeout 同样写终态', async () => {
            const result = await coordinator.executeTerminalTrigger(
                's1',
                'timeout',
            );
            expect(result).toEqual({
                status: 'COMPLETED',
                terminalWritten: true,
            });
            expect(mocks.terminal.markExtracted).toHaveBeenCalledTimes(1);
        });
    });

    describe('SKIP_TERMINAL（终态已存在）', () => {
        it('L3：返回 SKIPPED TERMINAL，pipeline.run 不被调用', async () => {
            mocks.terminal.isExtracted.mockResolvedValue(true);

            const result = await coordinator.triggerThreshold('s1');

            expect(result).toEqual({ status: 'SKIPPED', reason: 'TERMINAL' });
            expect(mocks.pipeline.run).not.toHaveBeenCalled();
            expect(mocks.metrics.count).toHaveBeenCalledWith('ltm.skip', {
                reason: 'TERMINAL',
            });
        });

        it('L1：返回 SKIPPED TERMINAL，markExtracted 不被调用', async () => {
            mocks.terminal.isExtracted.mockResolvedValue(true);

            const result = await coordinator.executeTerminalTrigger(
                's1',
                'explicit',
            );

            expect(result).toEqual({ status: 'SKIPPED', reason: 'TERMINAL' });
            expect(mocks.terminal.markExtracted).not.toHaveBeenCalled();
            expect(mocks.pipeline.run).not.toHaveBeenCalled();
        });
    });

    describe('SKIP_PROCESSING（processing 已存在）', () => {
        it('返回 SKIPPED PROCESSING，pipeline.run 不被调用', async () => {
            mocks.processing.current.mockResolvedValue('threshold');

            const result = await coordinator.triggerThreshold('s1');

            expect(result).toEqual({ status: 'SKIPPED', reason: 'PROCESSING' });
            expect(mocks.pipeline.run).not.toHaveBeenCalled();
            expect(mocks.metrics.count).toHaveBeenCalledWith('ltm.skip', {
                reason: 'PROCESSING',
            });
        });
    });

    describe('SKIP_LOCK（获锁失败）', () => {
        it('P1 acquire 返回 null，返回 SKIPPED LOCK', async () => {
            mocks.lock.acquire.mockResolvedValue(null);

            const result = await coordinator.triggerThreshold('s1');

            expect(result).toEqual({ status: 'SKIPPED', reason: 'LOCK' });
            expect(mocks.pipeline.run).not.toHaveBeenCalled();
            expect(mocks.terminal.isExtracted).not.toHaveBeenCalled();
            expect(mocks.metrics.count).toHaveBeenCalledWith('ltm.skip', {
                reason: 'LOCK',
            });
        });
    });

    describe('Phase 3 重试', () => {
        it('前两次 acquire null 第三次成功：p3.retry 埋点 2 次，最终 COMPLETED', async () => {
            // P1 成功 -> P3 失败、失败、成功
            mocks.lock.acquire
                .mockResolvedValueOnce('token-1')
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce('token-3');

            const result = await coordinator.executeTerminalTrigger(
                's1',
                'explicit',
            );

            expect(result).toEqual({
                status: 'COMPLETED',
                terminalWritten: true,
            });
            const retryCalls = mocks.metrics.count.mock.calls.filter(
                ([name]) => name === 'ltm.p3.retry',
            );
            expect(retryCalls).toHaveLength(2);
            expect(mocks.terminal.markExtracted).toHaveBeenCalledTimes(1);
        });

        it('3 次全失败：返回 COMPLETED terminalWritten=false，不写终态', async () => {
            mocks.lock.acquire
                .mockResolvedValueOnce('token-1') // P1
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);

            const result = await coordinator.triggerThreshold('s1');

            expect(result).toEqual({
                status: 'COMPLETED',
                terminalWritten: false,
            });
            const retryCalls = mocks.metrics.count.mock.calls.filter(
                ([name]) => name === 'ltm.p3.retry',
            );
            expect(retryCalls).toHaveLength(3);
        });
    });

    describe('Phase 2 finally 兜底', () => {
        it('pipeline.run 抛错后 processing.clear 仍被调用并向上抛出', async () => {
            const boom = new Error('pipeline boom');
            mocks.pipeline.run.mockRejectedValue(boom);

            await expect(coordinator.triggerThreshold('s1')).rejects.toThrow(
                'pipeline boom',
            );

            // catch 块清 1 次 + finally 块清 1 次
            expect(mocks.processing.clear).toHaveBeenCalledTimes(2);
            expect(mocks.terminal.markExtracted).not.toHaveBeenCalled();
        });
    });

    describe('Phase 3 二次终态校验', () => {
        it('P2 期间终态已被他人写入：返回 SKIPPED TERMINAL，不再写终态', async () => {
            // P1 时未提取，P3 二次校验时已提取
            mocks.terminal.isExtracted
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);

            const result = await coordinator.executeTerminalTrigger(
                's1',
                'explicit',
            );

            expect(result).toEqual({ status: 'SKIPPED', reason: 'TERMINAL' });
            expect(mocks.terminal.markExtracted).not.toHaveBeenCalled();
        });
    });

    describe('metrics 可选', () => {
        it('不注入 metrics 时所有埋点 no-op，流程正常', async () => {
            const deps: CoordinatorDeps = {
                lock: mocks.lock as any,
                terminal: mocks.terminal as any,
                processing: mocks.processing as any,
                pipeline: mocks.pipeline,
            };
            const c = new MemoryTriggerCoordinator(deps);

            const result = await c.triggerThreshold('s1');

            expect(result).toEqual({
                status: 'COMPLETED',
                terminalWritten: false,
            });
            // 不抛错即说明 metrics?. 短路正常
        });
    });
});

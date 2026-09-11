/**
 * ForgetScanner 单元测试
 *
 * 测试目标：定点参数透传、启动不立即扫描（防重启风暴）、回调触发扫描并打点、
 *           重复 start 不叠加定时器、stop 透传到调度句柄
 * Mock 依赖：@/lib/logger —— 不连真实 DB、不连真实定时器
 * 真实逻辑：ForgetScanner 的参数装配、句柄持有与生命周期
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import {
    ForgetScanner,
    FORGET_SCAN_HOUR,
    FORGET_SCAN_MINUTE,
} from '@/services/memory/trigger/forgetScanner';
import type { ForgetScanReport } from '@/services/memory/forget.service';

function makeReport(
    overrides: Partial<ForgetScanReport> = {},
): ForgetScanReport {
    return {
        dryRun: false,
        backfilled: 0,
        categories: [],
        totalCandidates: 0,
        totalDeleted: 0,
        truncated: false,
        ...overrides,
    };
}

/**
 * 用「捕获回调 + 返回 stop spy」替代真实 setTimeout，
 * 测试可直接手动触发被调度的那一轮扫描。
 */
function makeScheduler() {
    // 每次调度返回独立句柄：真实实现里 stop 句柄是每次 scheduleNext 新建的
    const handles: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const schedule = vi.fn(
        (_hour: number, _minute: number, _cb: () => Promise<void> | void) => {
            const handle = { stop: vi.fn() };
            handles.push(handle);
            return handle;
        },
    );
    return {
        schedule,
        handles,
        /** 第 n 次注册的句柄（默认最后一次） */
        lastHandle: () => handles[handles.length - 1]!,
        /** 取出第 n 次注册的回调（默认最后一次） */
        lastCallback: () =>
            schedule.mock.calls[schedule.mock.calls.length - 1]![2],
    };
}

let scheduler: ReturnType<typeof makeScheduler>;
let scan: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    scheduler = makeScheduler();
    scan = vi.fn().mockResolvedValue(makeReport());
});

function buildScanner(hour?: number, minute?: number): ForgetScanner {
    return new ForgetScanner({
        scan: scan as unknown as () => Promise<ForgetScanReport>,
        schedule: scheduler.schedule,
        hour,
        minute,
    });
}

describe('ForgetScanner - 定点参数', () => {
    it('默认 03:00，与导出的常量为同一来源', async () => {
        expect(FORGET_SCAN_HOUR).toBe(3);
        expect(FORGET_SCAN_MINUTE).toBe(0);

        buildScanner().start();

        expect(scheduler.schedule).toHaveBeenCalledTimes(1);
        const [hour, minute] = scheduler.schedule.mock.calls[0]!;
        expect(hour).toBe(3);
        expect(minute).toBe(0);
    });

    it('自定义 hour/minute 透传到调度器', () => {
        buildScanner(4, 30).start();

        const [hour, minute] = scheduler.schedule.mock.calls[0]!;
        expect(hour).toBe(4);
        expect(minute).toBe(30);
    });

    it('start() 只注册定时器，不立即扫描（重启风暴防护）', () => {
        buildScanner().start();

        expect(scan).not.toHaveBeenCalled();
    });
});

describe('ForgetScanner - 触发一轮', () => {
    it('调度回调触发时调用 scan，并以真删模式返回报告', async () => {
        const report = makeReport({ totalCandidates: 12, totalDeleted: 12 });
        scan.mockResolvedValue(report);

        const scanner = buildScanner();
        scanner.start();

        const result = await scanner.scanOnce();

        expect(scan).toHaveBeenCalledTimes(1);
        expect(result).toBe(report);
        expect(result.dryRun).toBe(false);
    });

    it('回调体等待扫描完成后才 resolve（不并发重入）', async () => {
        let release!: (r: ForgetScanReport) => void;
        scan.mockReturnValue(
            new Promise<ForgetScanReport>((resolve) => {
                release = resolve;
            }),
        );

        buildScanner().start();
        const cb = scheduler.lastCallback();

        let settled = false;
        const pending = Promise.resolve(cb()).then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);
        expect(scan).toHaveBeenCalledTimes(1);

        release(makeReport({ totalDeleted: 3 }));
        await pending;
        expect(settled).toBe(true);
    });

    it('扫描抛错时向上冒泡，交给调度器的 catch 兜底（不静默吞掉）', async () => {
        const boom = new Error('mongo down');
        scan.mockRejectedValue(boom);

        buildScanner().start();
        const cb = scheduler.lastCallback();

        await expect(cb()).rejects.toThrow('mongo down');
    });
});

describe('ForgetScanner - 生命周期', () => {
    it('stop() 透传到调度句柄，重复 stop 安全', () => {
        const scanner = buildScanner();
        scanner.start();

        scanner.stop();
        expect(scheduler.handles[0]!.stop).toHaveBeenCalledTimes(1);

        scanner.stop();
        expect(scheduler.handles[0]!.stop).toHaveBeenCalledTimes(1); // 句柄已释放，不再重复调用
    });

    it('未 start 时 stop 为空操作', () => {
        buildScanner().stop();

        expect(scheduler.handles).toEqual([]);
        expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('重复 start 先停旧句柄，定时器不叠加', () => {
        const scanner = buildScanner();
        scanner.start();
        scanner.start();

        expect(scheduler.handles[0]!.stop).toHaveBeenCalledTimes(1);
        expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    });

    it('stop 后可重新 start：新句柄生效，旧句柄不被重复停止', () => {
        const scanner = buildScanner();
        scanner.start();

        scanner.stop();
        expect(scheduler.handles[0]!.stop).toHaveBeenCalledTimes(1);

        scanner.start();
        expect(scheduler.schedule).toHaveBeenCalledTimes(2);

        scanner.stop();
        expect(scheduler.handles[0]!.stop).toHaveBeenCalledTimes(1); // 旧句柄不再被触碰
        expect(scheduler.handles[1]!.stop).toHaveBeenCalledTimes(1); // 新句柄被停
    });
});

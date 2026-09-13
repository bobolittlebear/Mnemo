/**
 * forget.service 单元测试
 *
 * 测试目标：四条件 filter 构建、可删类别顺序、dry-run 不写库、
 *           单次上限截断、存量 backfill 隔离、整轮 guard（瞬态失败兜底）、
 *           定点调度延迟与递归、调度层不自行重试
 * Mock 依赖：MemoryFact（find / countDocuments / updateMany）
 *           —— 不连真实 DB（runGuardedTask 走真实实现）
 * 真实逻辑：filter 组装、预算分配、报告汇总、递归 setTimeout 调度
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockLogError } = vi.hoisted(() => ({
    mockLogError: vi.fn(),
}));

vi.mock('@/models/MemoryFact', () => ({
    MemoryFact: {
        find: vi.fn(),
        countDocuments: vi.fn(),
        updateMany: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: mockLogError,
        debug: vi.fn(),
    }),
}));

import { MemoryFact } from '@/models/MemoryFact';
import {
    buildForgetFilter,
    deletableCategories,
    backfillLastSignificantAt,
    runForgetScan,
    msUntilNextDaily,
    scheduleDailyAt,
} from '@/services/memory/forget.service';
import {
    FORGET_INACTIVE_DAYS,
    FORGET_MAX_DELETES_PER_RUN,
    FORGET_NEVER_DELETE,
} from '@/utils/config';

const mockedFind = vi.mocked(MemoryFact.find);
const mockedCountDocuments = vi.mocked(MemoryFact.countDocuments);
const mockedUpdateMany = vi.mocked(MemoryFact.updateMany);

const DAY_MS = 86_400_000;

/** Mock MemoryFact.find().select().limit().lean() 链式调用 */
function mockFindChain(docs: Array<{ _id: string }>) {
    const lean = vi.fn().mockResolvedValue(docs);
    const limit = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ limit });
    mockedFind.mockReturnValue({ select } as any);
    return { select, limit, lean };
}

function makeIds(n: number, prefix = 'id'): Array<{ _id: string }> {
    return Array.from({ length: n }, (_, i) => ({ _id: `${prefix}${i + 1}` }));
}

/** 让候选数按 category 区分，其余类别为 0 */
function countPerCategory(byCategory: Record<string, number>) {
    mockedCountDocuments.mockImplementation(((filter: any) =>
        Promise.resolve(byCategory[filter.category] ?? 0)) as any);
}

beforeEach(() => {
    vi.clearAllMocks();
    // 默认：backfill 无改动、无候选
    mockedUpdateMany.mockResolvedValue({ modifiedCount: 0 } as any);
    mockedCountDocuments.mockResolvedValue(0 as any);
    mockFindChain([]);
});

// ────────────────────── M7-1 / M7-2: filter 结构 ──────────────────────

describe('buildForgetFilter', () => {
    const NOW = new Date('2026-09-11T03:00:00.000Z').getTime();

    it('M7-1 - 返回五个键，且 type/category 等值、deletedAt/confidence 带正确算子', () => {
        const filter = buildForgetFilter('event', NOW);

        expect(Object.keys(filter).sort()).toEqual([
            'category',
            'confidence',
            'deletedAt',
            'lastSignificantAt',
            'type',
        ]);
        expect(filter.type).toBe('fact');
        expect(filter.category).toBe('event');
        expect(filter.deletedAt).toEqual({ $exists: false });
        expect(filter.confidence).toEqual({ $lt: 0.7 });
    });

    it('M7-2 - lastSignificantAt 合并 $exists 保底与 $lt 范围，阈值按 category 天数计算', () => {
        const filter = buildForgetFilter('event', NOW) as any;
        const window = filter.lastSignificantAt;

        // 单子文档：拆成两个 lastSignificantAt 键会互相覆盖，丢掉 $exists 保底
        expect(Object.keys(window).sort()).toEqual(['$exists', '$lt']);
        expect(window.$exists).toBe(true);
        expect(window.$lt).toBeInstanceOf(Date);
        expect(window.$lt.getTime()).toBe(NOW - 14 * DAY_MS);

        // 不同 category 用各自阈值：personal_info 180 天
        const longFilter = buildForgetFilter('personal_info', NOW) as any;
        expect(longFilter.lastSignificantAt.$lt.getTime()).toBe(
            NOW - 180 * DAY_MS,
        );
    });

    it('未知 category 抛错，不以默认阈值兜底', () => {
        expect(() => buildForgetFilter('not_a_category', NOW)).toThrow(
            '未知的记忆类别',
        );
    });
});

// ────────────────────── M7-3: 可删类别 ──────────────────────

describe('deletableCategories', () => {
    it('M7-3 - 排除 NEVER_DELETE 且按阈值升序', () => {
        const result = deletableCategories();
        const names = result.map((c) => c.category);
        const days = result.map((c) => c.inactiveDays);

        for (const never of FORGET_NEVER_DELETE) {
            expect(names).not.toContain(never);
        }
        expect(names).toHaveLength(9);

        // 升序：event/other=14 → diet=30 → goal/decision=60 → … → 180
        expect(days).toEqual([...days].sort((a, b) => a - b));
        expect(days[0]).toBe(14);
        expect(days[days.length - 1]).toBe(180);

        // 顺序取值与阈值表一致（不重复实现排序逻辑）
        for (const { category, inactiveDays } of result) {
            expect(inactiveDays).toBe(FORGET_INACTIVE_DAYS[category]);
        }
    });
});

// ────────────────────── M7-4: dry-run 不写库 ──────────────────────

describe('runForgetScan - dryRun', () => {
    it('M7-4 - dryRun 只统计候选、不查 _id、不软删（仅 backfill 写库）', async () => {
        mockedCountDocuments.mockResolvedValue(3 as any);

        const report = await runForgetScan({ dryRun: true });

        // 软删路径未触发
        expect(mockedFind).not.toHaveBeenCalled();
        // 唯一的 updateMany 是 backfill
        expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
        const [backfillFilter, backfillUpdate] =
            mockedUpdateMany.mock.calls[0]!;
        expect((backfillFilter as any).lastSignificantAt).toEqual({
            $exists: false,
        });
        expect(backfillUpdate).toEqual([
            { $set: { lastSignificantAt: '$createdAt' } },
        ]);

        expect(report.dryRun).toBe(true);
        expect(report.totalDeleted).toBe(0);
        expect(report.totalCandidates).toBe(27);
        for (const c of report.categories) {
            expect(c.deleted).toBe(0);
            expect(c.candidates).toBe(3);
        }
    });

    it('不传 opts 时默认为 dry-run（安全侧）', async () => {
        countPerCategory({ event: 2 });

        const report = await runForgetScan();

        expect(report.dryRun).toBe(true);
        expect(report.totalCandidates).toBe(2);
        expect(report.totalDeleted).toBe(0);
        expect(mockedFind).not.toHaveBeenCalled();
    });

    it('候选为 0 的类别不进报告', async () => {
        const report = await runForgetScan({ dryRun: true });

        expect(report.categories).toEqual([]);
        expect(report.totalCandidates).toBe(0);
        expect(report.truncated).toBe(false);
    });
});

// ────────────────────── M7-5: 单次上限 ──────────────────────

describe('runForgetScan - 单次删除上限', () => {
    it('M7-5 - 候选超上限时软删封顶，报告仍暴露全量候选与截断标记', async () => {
        // event 与 other 同为 14 天阈值，各 80 条候选；其余类别为 0
        countPerCategory({ event: 80, other: 80 });
        mockFindChain(makeIds(FORGET_MAX_DELETES_PER_RUN));
        mockedUpdateMany
            .mockResolvedValueOnce({ modifiedCount: 0 } as any) // backfill
            .mockResolvedValue({ modifiedCount: 50 } as any); // 软删

        const report = await runForgetScan({ dryRun: false });

        // 全量候选如实报告（暴露积压规模），删除封顶 50
        expect(report.totalCandidates).toBe(160);
        expect(report.totalDeleted).toBe(50);

        const [softDeleteFilter, softDeleteUpdate] =
            mockedUpdateMany.mock.calls[1]!;
        // 软删走定向 _id，不再复用四条件（避免二次判定语义漂移）
        expect(Object.keys(softDeleteFilter as any)).toEqual(['_id']);
        expect((softDeleteFilter as any)._id.$in).toHaveLength(50);
        expect(softDeleteUpdate).toEqual({
            $set: { deletedAt: expect.any(Date) },
        });

        // 预算耗尽即停后续类：只有首个类别查了 _id
        expect(mockedFind).toHaveBeenCalledTimes(1);
        const firstFindFilter = (
            mockedFind.mock.calls[0] as unknown as [Record<string, unknown>]
        )[0]!;
        expect(firstFindFilter).toMatchObject({
            category: 'event',
            type: 'fact',
        });

        expect(report.truncated).toBe(true);
        expect(report.categories.map((c) => c.category)).toEqual([
            'event',
            'other',
        ]);
        expect(report.categories[0]!.deleted).toBe(50);
        expect(report.categories[1]!.deleted).toBe(0);
    });

    it('候选未超上限时逐类删满、不标记截断', async () => {
        countPerCategory({ event: 30, diet: 5 });
        mockFindChain(makeIds(30));
        mockedUpdateMany
            .mockResolvedValueOnce({ modifiedCount: 0 } as any) // backfill
            .mockResolvedValueOnce({ modifiedCount: 30 } as any) // event
            .mockResolvedValue({ modifiedCount: 5 } as any); // diet

        const report = await runForgetScan({ dryRun: false });

        expect(report.truncated).toBe(false);
        expect(report.totalCandidates).toBe(35);
        expect(report.totalDeleted).toBe(35);
        expect(report.categories.map((c) => [c.category, c.deleted])).toEqual([
            ['event', 30],
            ['diet', 5],
        ]);
        // 两类都查了 _id，预算够
        expect(mockedFind).toHaveBeenCalledTimes(2);
    });

    it('无候选类别不消耗预算、不查 _id', async () => {
        countPerCategory({ diet: 3 });
        mockFindChain(makeIds(3));
        mockedUpdateMany
            .mockResolvedValueOnce({ modifiedCount: 0 } as any)
            .mockResolvedValue({ modifiedCount: 3 } as any);

        const report = await runForgetScan({ dryRun: false });

        expect(report.categories.map((c) => c.category)).toEqual(['diet']);
        expect(mockedFind).toHaveBeenCalledTimes(1);
        expect(report.totalDeleted).toBe(3);
    });
});

// ────────────────────── 整轮 guard（runGuardedTask） ──────────────────────

describe('runForgetScan - 整轮 guard', () => {
    it('整轮依赖失败（连接被回收等瞬态故障）→ 返回空报告、不抛', async () => {
        mockedUpdateMany.mockRejectedValue(
            new Error('MongoPoolClearedError: pool cleared'),
        );

        const report = await runForgetScan({ dryRun: false });

        // 空报告而非抛出：调用方（调度层 / CLI）无需处理失败
        expect(report).toEqual({
            dryRun: false,
            backfilled: 0,
            categories: [],
            totalCandidates: 0,
            totalDeleted: 0,
            truncated: false,
        });
        // backfill 是整轮第一步，它失败则扫描阶段不执行
        expect(mockedCountDocuments).not.toHaveBeenCalled();
        expect(mockedFind).not.toHaveBeenCalled();
    });

    it('整轮失败时保留 dryRun 语义（默认仍为 true）', async () => {
        mockedUpdateMany.mockRejectedValue(new Error('server selection'));

        const report = await runForgetScan();

        expect(report.dryRun).toBe(true);
        expect(report.totalDeleted).toBe(0);
    });

    it('整轮先失败后恢复 → 重试成功即返回真实报告，不再兜成空报告', async () => {
        // 首次 backfill 抛错（瞬态），重试时恢复为无改动
        mockedUpdateMany
            .mockRejectedValueOnce(new Error('MongoPoolClearedError'))
            .mockResolvedValue({ modifiedCount: 0 } as any);
        countPerCategory({ diet: 2 });
        mockFindChain(makeIds(2));

        const report = await runForgetScan({ dryRun: true });

        expect(report.dryRun).toBe(true);
        expect(report.totalCandidates).toBe(2);
        expect(report.categories.map((c) => c.category)).toEqual(['diet']);
    });
});

// ────────────────────── M7-7: backfill 隔离 ──────────────────────

describe('backfillLastSignificantAt', () => {
    it('M7-7 - 只执行 backfill 管道更新，不扫描不软删', async () => {
        mockedUpdateMany.mockResolvedValue({ modifiedCount: 7 } as any);

        const modified = await backfillLastSignificantAt();

        expect(modified).toBe(7);
        expect(mockedUpdateMany).toHaveBeenCalledTimes(1);

        const [filter, update] = mockedUpdateMany.mock.calls[0]!;
        expect(filter).toEqual({
            type: 'fact',
            lastSignificantAt: { $exists: false },
        });
        // 必须引用字段值而非字面量，否则存量记忆会从今天重新变老
        expect(update).toEqual([{ $set: { lastSignificantAt: '$createdAt' } }]);
        expect(JSON.stringify(update)).not.toContain('deletedAt');

        expect(mockedCountDocuments).not.toHaveBeenCalled();
        expect(mockedFind).not.toHaveBeenCalled();
    });

    it('runForgetScan 第一步确实调用了 backfill', async () => {
        mockedUpdateMany.mockResolvedValueOnce({ modifiedCount: 9 } as any);
        countPerCategory({});

        const report = await runForgetScan({ dryRun: true });

        expect(report.backfilled).toBe(9);
        expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    });
});

// ────────────────────── M7-6: 定点调度 ──────────────────────

describe('scheduleDailyAt / msUntilNextDaily', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('msUntilNextDaily - 目标时刻之前取当天剩余，之后取到明天', () => {
        const at2 = new Date('2026-09-11T02:00:00').getTime();
        const at4 = new Date('2026-09-11T04:00:00').getTime();
        const exactly3 = new Date('2026-09-11T03:00:00').getTime();

        expect(msUntilNextDaily(3, 0, at2)).toBe(3_600_000);
        expect(msUntilNextDaily(3, 0, at4)).toBe(23 * 3_600_000);
        // 恰好落在目标时刻 → 排到明天，避免同一时刻重复触发
        expect(msUntilNextDaily(3, 0, exactly3)).toBe(24 * 3_600_000);
    });

    it('M7-6 - 02:00 起首次延迟 ≈1h', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T02:00:00'));
        const cb = vi.fn().mockResolvedValue(undefined);

        scheduleDailyAt(3, 0, cb);

        await vi.advanceTimersByTimeAsync(3_600_000 - 1);
        expect(cb).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('M7-6 - 04:00 起首次延迟 ≈23h', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T04:00:00'));
        const cb = vi.fn().mockResolvedValue(undefined);

        scheduleDailyAt(3, 0, cb);

        await vi.advanceTimersByTimeAsync(22 * 3_600_000 + 3_599_000);
        expect(cb).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('M7-6 - 递归重排且不重叠：每天一次，任意时刻只有一个待触发 timer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T02:00:00'));
        const cb = vi.fn().mockResolvedValue(undefined);

        scheduleDailyAt(3, 0, cb);

        await vi.advanceTimersByTimeAsync(3_600_000); // 第 1 天 03:00
        expect(cb).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1); // 重排后仍只有一个

        await vi.advanceTimersByTimeAsync(24 * 3_600_000); // 第 2 天 03:00
        expect(cb).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('cb 抛错不中断每日链条', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T02:00:00'));
        const cb = vi
            .fn()
            .mockRejectedValueOnce(new Error('mongo down'))
            .mockResolvedValue(undefined);

        scheduleDailyAt(3, 0, cb);

        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(cb).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(cb).toHaveBeenCalledTimes(2);
    });

    it('cb 抛错只记日志并照常排下一轮：调度层不做重试（重试归 runGuardedTask，避免双重重试）', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T02:00:00'));
        const cb = vi.fn().mockRejectedValue(new Error('mongo down'));

        scheduleDailyAt(3, 0, cb);

        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(mockLogError).toHaveBeenCalledWith('遗忘定时任务执行失败', {
            error: expect.any(Error),
        });

        // 往后推 10 分钟：调度层不得自行补跑（否则与任务内的 withRetry 叠加）
        await vi.advanceTimersByTimeAsync(600_000);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(mockLogError).toHaveBeenCalledTimes(1);
    });

    it('cb 执行途中 stop()：在途回调结束后不得重排（防链条复活）', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T02:00:00'));

        let release!: () => void;
        const cb = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );

        const handle = scheduleDailyAt(3, 0, cb);

        // 回调已触发、卡在 pending：此刻 timer 已消费，clearTimeout 对它无效
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(cb).toHaveBeenCalledTimes(1);

        handle.stop();
        release();
        await vi.advanceTimersByTimeAsync(0); // 冲掉收尾的 scheduleNext

        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(48 * 3_600_000);
        expect(cb).toHaveBeenCalledTimes(1); // stopped 标志兜住了在途重排
    });

    it('stop() 终止整条递归链', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T02:00:00'));
        const cb = vi.fn().mockResolvedValue(undefined);

        const handle = scheduleDailyAt(3, 0, cb);

        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(cb).toHaveBeenCalledTimes(1);

        handle.stop();
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(48 * 3_600_000);
        expect(cb).toHaveBeenCalledTimes(1); // 不再触发
    });
});

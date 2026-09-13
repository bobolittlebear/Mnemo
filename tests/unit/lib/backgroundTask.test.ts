/**
 * backgroundTask 单元测试
 *
 * 测试目标：runGuardedTask 的三条路径 —— fn 成功、首次失败后重试成功、
 *           fn 重试耗尽；以及「永不抛出」契约与重试档位转发
 * Mock 依赖：@/lib/logger；withRetry 用真实实现（包一层 spy 便于断言档位转发）
 * 真实逻辑：重试调用次数、返回值兜底、重试档位转发
 *
 * 注：连接探针（ensureConnected）已移除——连接故障表现为首个查询抛错，与其它
 * 瞬态故障走同一条 withRetry 路径，由 driver 自愈兜住。故本文件不再有任何
 * ensureConnected 相关用例，也不 mock @/db。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockLogWarn, mockLogError } = vi.hoisted(() => ({
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: mockLogWarn,
        error: mockLogError,
        debug: vi.fn(),
    }),
}));

// 保留真实重试行为（指数退避 + 错误分类），只包一层 spy 以便断言档位转发
vi.mock('@/lib/retry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/retry')>();
    return { ...actual, withRetry: vi.fn(actual.withRetry) };
});

import { runGuardedTask } from '@/lib/backgroundTask';
import { withRetry } from '@/lib/retry';

const withRetrySpy = vi.mocked(withRetry);

/** 退避抖动归零，重试不真实等待 */
const NO_BACKOFF = { baseDelayMs: 0, maxDelayMs: 0 };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('runGuardedTask - 成功路径', () => {
    it('fn 成功 → 返回 fn 的结果，只执行一次，不记 error/warn', async () => {
        const fn = vi.fn().mockResolvedValue({ totalDeleted: 7 });

        const result = await runGuardedTask('forget-scan', fn);

        expect(result).toEqual({ totalDeleted: 7 });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(withRetrySpy).toHaveBeenCalledTimes(1);
        expect(mockLogError).not.toHaveBeenCalled();
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('首次抛错、重试成功 → 返回结果而非 null', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('MongoPoolClearedError'))
            .mockResolvedValue('recovered');

        const result = await runGuardedTask('l2-timeout-scan', fn, NO_BACKOFF);

        expect(result).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
        // 重试成功即不触发兜底日志
        expect(
            mockLogError.mock.calls.filter(
                ([message]) => message === '后台任务本轮失败，重试已耗尽',
            ),
        ).toHaveLength(0);
    });

    it('fn 返回 falsy 值（0 / 空串）也原样透出，不误判成本轮未执行', async () => {
        await expect(
            runGuardedTask('forget-scan', vi.fn().mockResolvedValue(0)),
        ).resolves.toBe(0);
        await expect(
            runGuardedTask('forget-scan', vi.fn().mockResolvedValue('')),
        ).resolves.toBe('');
    });
});

describe('runGuardedTask - 重试耗尽', () => {
    it('fn 持续抛错 → 返回 null、不抛，按次数耗尽后记 error', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('embedding down'));

        const result = await runGuardedTask('note-reindex', fn, {
            retries: 3,
            ...NO_BACKOFF,
        });

        expect(result).toBeNull();
        expect(fn).toHaveBeenCalledTimes(3);

        // withRetry 也复用同一个 logger（'All attempts exhausted' 等重试遥测），
        // 故只筛出兜底那一条
        const exhausted = mockLogError.mock.calls.filter(
            ([message]) => message === '后台任务本轮失败，重试已耗尽',
        );
        expect(exhausted).toHaveLength(1);
        const [, errorContext] = exhausted[0]!;
        expect(errorContext).toMatchObject({ task: 'note-reindex' });
        expect((errorContext as any).error).toBeInstanceOf(Error);
    });

    it('不重试的客户端错误（4xx）也兜成 null，不向外抛', async () => {
        const err: any = new Error('bad request');
        err.status = 400;
        const fn = vi.fn().mockRejectedValue(err);

        await expect(runGuardedTask('note-reindex', fn)).resolves.toBeNull();
        // 4xx 不可重试：只试一次就放弃
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('永不 reject：逐条 fn 全失败也只有 null', async () => {
        const fn = vi.fn().mockRejectedValue('非 Error 抛出物');

        await expect(
            runGuardedTask('l2-timeout-scan', fn, NO_BACKOFF),
        ).resolves.toBeNull();
    });
});

describe('runGuardedTask - 重试档位', () => {
    it('不传 opts 时默认 2 次尝试、2s/8s 退避档位', async () => {
        await runGuardedTask('forget-scan', vi.fn().mockResolvedValue(1));

        const [fnArg, retryOpts] = withRetrySpy.mock.calls[0]!;
        expect(typeof fnArg).toBe('function');
        expect(retryOpts).toMatchObject({
            attempts: 2,
            baseDelay: 2_000,
            maxDelay: 8_000,
        });
        expect(retryOpts?.logger).toBeDefined();
    });

    it('opts 覆盖默认档位，且实际尝试次数按透传的 retries 生效', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('embedding down'));

        await runGuardedTask('note-reindex', fn, {
            retries: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
        });

        const [fnArg, retryOpts] = withRetrySpy.mock.calls[0]!;
        expect(fnArg).toBe(fn);
        expect(retryOpts).toMatchObject({
            attempts: 3,
            baseDelay: 0,
            maxDelay: 0,
        });
        // 档位不只是转发：真实重试层确实按 3 次执行
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('透传的 fn 被原样交给 withRetry（不额外包一层改变返回语义）', async () => {
        const fn = vi.fn().mockResolvedValue('ok');

        await runGuardedTask('forget-scan', fn);

        expect(withRetrySpy.mock.calls[0]![0]).toBe(fn);
    });
});

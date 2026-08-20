/**
 * withRetry 单元测试
 *
 * 验收标准：
 * 2.4 重试生效 — 429 错误，3 次重试，退避 1s → 2s → 4s
 * 2.4 快速失败 — 401 错误，立即抛出，仅 1 次尝试
 * 2.4 并发安全 — 50 条并发重试，无内存泄漏 / 事件循环阻塞 / unhandled rejection
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger as WinstonLogger } from 'winston';
import { withRetry } from '@/lib/retry';

// ── 测试用 logger mock ──
// withRetry 仅调用 warn/error，这里只 mock 需要的方法
// 交叉类型让 TS 同时认 WinstonLogger（传入 withRetry）和 Mock（断言 .mock.calls）
type MockLogger = WinstonLogger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
};

function createMockLogger(): MockLogger {
    return {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    } as unknown as MockLogger;
}

// ── 构造 API 错误的工具 ──
function apiError(status: number, message?: string) {
    return {
        response: { status },
        message: message ?? `HTTP ${status}`,
    };
}

describe('withRetry', () => {
    let logger: ReturnType<typeof createMockLogger>;

    beforeEach(() => {
        logger = createMockLogger();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ═══════════════════════════════════════
    // 验收标准 2.4 — 重试生效
    // ═══════════════════════════════════════
    describe('重试生效', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            // mock Math.random → 1.0，使 full jitter 取到上界，得到确定性退避值
            vi.spyOn(Math, 'random').mockReturnValue(1);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('429 错误应重试 3 次，退避间隔递增 1s → 2s → 4s', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(429, 'Too Many Requests'));

            // attempts: 4 = 1 次初始 + 3 次重试
            const promise = withRetry(mockFn, {
                attempts: 4,
                baseDelay: 1000,
                maxDelay: 10000,
                logger,
            });
            // 防止假时钟推进期间 promise rejection 未被捕获
            promise.catch(() => {});

            // 推进假时钟覆盖所有退避（1s + 2s + 4s = 7s，推 10s 足够）
            await vi.advanceTimersByTimeAsync(10000);

            await expect(promise).rejects.toEqual(
                apiError(429, 'Too Many Requests'),
            );

            // 总调用次数 = 1 初始 + 3 重试 = 4
            expect(mockFn).toHaveBeenCalledTimes(4);

            // 从 logger.warn 调用中提取退避延迟
            const retryLogs = logger.warn.mock.calls;
            expect(retryLogs).toHaveLength(3);

            const delays = retryLogs.map((call) => call[1].delay);
            expect(delays).toEqual([1000, 2000, 4000]);

            // 验证每次日志的 attempt 编号
            expect(retryLogs[0]![1].attempt).toBe(1);
            expect(retryLogs[1]![1].attempt).toBe(2);
            expect(retryLogs[2]![1].attempt).toBe(3);

            // 验证最终日志记录了 exhausted
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(logger.error.mock.calls[0]![1]).toMatchObject({
                status: 429,
                totalAttempts: 4,
            });
        });

        it('5xx 服务端错误也应触发重试', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(apiError(503, 'Service Unavailable'))
                .mockRejectedValueOnce(apiError(502, 'Bad Gateway'))
                .mockResolvedValueOnce('recovered');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1000,
                maxDelay: 10000,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(5000);

            const result = await promise;
            expect(result).toBe('recovered');
            expect(mockFn).toHaveBeenCalledTimes(3);
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });
    });

    // ═══════════════════════════════════════
    // 验收标准 2.4 — 快速失败
    // ═══════════════════════════════════════
    describe('快速失败', () => {
        it('401 错误应立即抛出，仅 1 次尝试，不重试', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(401, 'Unauthorized'));

            await expect(
                withRetry(mockFn, { attempts: 4, baseDelay: 1000, logger }),
            ).rejects.toEqual(apiError(401, 'Unauthorized'));

            // 仅调用 1 次 — 不可重试错误直接抛出
            expect(mockFn).toHaveBeenCalledTimes(1);

            // 不应有重试日志
            expect(logger.warn).not.toHaveBeenCalled();

            // 应有 error 日志记录"不可重试"
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(logger.error.mock.calls[0]![0]).toBe(
                'Non-retryable error, aborting',
            );
            expect(logger.error.mock.calls[0]![1]).toMatchObject({
                status: 401,
                code: undefined,
            });
        });

        it('400 错误也应立即抛出不重试', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(400, 'Bad Request'));

            await expect(
                withRetry(mockFn, { attempts: 3, logger }),
            ).rejects.toEqual(apiError(400, 'Bad Request'));

            expect(mockFn).toHaveBeenCalledTimes(1);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('404 错误也应立即抛出不重试', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(404, 'Not Found'));

            await expect(
                withRetry(mockFn, { attempts: 3, logger }),
            ).rejects.toEqual(apiError(404, 'Not Found'));

            expect(mockFn).toHaveBeenCalledTimes(1);
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════
    // 边缘场景 — maxDelay 上限截断
    // ═══════════════════════════════════════
    describe('maxDelay 上限截断', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            // Math.random → 1.0 使 full jitter 取到上界，得到确定性退避值
            vi.spyOn(Math, 'random').mockReturnValue(1);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('退避延迟不应超过 maxDelay，即使指数增长远超上限', async () => {
            // baseDelay=1000, maxDelay=10000（与默认值一致）, attempts=7
            // 理论指数：1000 → 2000 → 4000 → 8000 → 16000 → 32000 → 64000
            // 实际截断：1000 → 2000 → 4000 → 8000 → 10000 → 10000
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(429, 'Too Many Requests'));

            const promise = withRetry(mockFn, {
                attempts: 7,
                baseDelay: 1000,
                maxDelay: 10000,
                logger,
            });
            promise.catch(() => {});

            // 推进足够长时间覆盖所有退避（1000+2000+4000+8000+10000+10000=35000）
            await vi.advanceTimersByTimeAsync(40000);

            await expect(promise).rejects.toEqual(
                apiError(429, 'Too Many Requests'),
            );

            expect(mockFn).toHaveBeenCalledTimes(7);

            const delays = logger.warn.mock.calls.map((call) => call[1].delay);
            expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);

            // 确保所有延迟都不超过 maxDelay
            delays.forEach((d) => expect(d).toBeLessThanOrEqual(10000));
        });
    });

    // ═══════════════════════════════════════
    // 边缘场景 — 纯网络错误（无 response）
    // ═══════════════════════════════════════
    describe('纯网络错误（无 response）', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.spyOn(Math, 'random').mockReturnValue(0);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('ETIMEDOUT 错误应触发重试', async () => {
            const networkErr = new Error('connect ETIMEDOUT');
            (networkErr as any).code = 'ETIMEDOUT';

            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(networkErr)
                .mockResolvedValueOnce('ok');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            const result = await promise;
            expect(result).toBe('ok');
            expect(mockFn).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0]![1]).toMatchObject({
                code: 'ETIMEDOUT',
            });
        });

        it('ECONNRESET 错误应触发重试', async () => {
            const networkErr = new Error('read ECONNRESET');
            (networkErr as any).code = 'ECONNRESET';

            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(networkErr)
                .mockResolvedValueOnce('ok');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            const result = await promise;
            expect(result).toBe('ok');
            expect(mockFn).toHaveBeenCalledTimes(2);
        });

        it('ECONNREFUSED 错误应触发重试', async () => {
            const networkErr = new Error('connect ECONNREFUSED');
            (networkErr as any).code = 'ECONNREFUSED';

            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(networkErr)
                .mockResolvedValueOnce('ok');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            const result = await promise;
            expect(result).toBe('ok');
        });

        it('ENOTFOUND 错误应触发重试', async () => {
            const networkErr = new Error('getaddrinfo ENOTFOUND');
            (networkErr as any).code = 'ENOTFOUND';

            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(networkErr)
                .mockResolvedValueOnce('ok');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            const result = await promise;
            expect(result).toBe('ok');
        });

        it('ERR_CANCELED（axios 取消）应触发重试', async () => {
            const networkErr = new Error('canceled');
            (networkErr as any).code = 'ERR_CANCELED';

            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(networkErr)
                .mockResolvedValueOnce('ok');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            const result = await promise;
            expect(result).toBe('ok');
        });

        it('纯网络错误重试耗尽后应抛出原始错误', async () => {
            const networkErr = new Error('connect ETIMEDOUT');
            (networkErr as any).code = 'ETIMEDOUT';

            const mockFn = vi
                .fn()
                .mockRejectedValue(networkErr);

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                logger,
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            await expect(promise).rejects.toThrow('connect ETIMEDOUT');
            expect(mockFn).toHaveBeenCalledTimes(3);
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(logger.error.mock.calls[0]![0]).toBe('All attempts exhausted');
        });
    });

    // ═══════════════════════════════════════
    // 边缘场景 — logger 为 undefined
    // ═══════════════════════════════════════
    describe('logger 为 undefined', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.spyOn(Math, 'random').mockReturnValue(0);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('不传 logger 时重试仍正常工作，不抛 TypeError', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValueOnce(apiError(429))
                .mockResolvedValueOnce('ok');

            const promise = withRetry(mockFn, {
                attempts: 3,
                baseDelay: 1,
                maxDelay: 10,
                // 故意不传 logger
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            const result = await promise;
            expect(result).toBe('ok');
            expect(mockFn).toHaveBeenCalledTimes(2);
        });

        it('不传 logger 时不可重试错误仍正常抛出', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(401, 'Unauthorized'));

            await expect(
                withRetry(mockFn, {
                    attempts: 3,
                    baseDelay: 1,
                    maxDelay: 10,
                    // 故意不传 logger
                }),
            ).rejects.toEqual(apiError(401, 'Unauthorized'));

            expect(mockFn).toHaveBeenCalledTimes(1);
        });

        it('不传 logger 时重试耗尽仍正常抛出', async () => {
            const mockFn = vi
                .fn()
                .mockRejectedValue(apiError(500, 'Internal Error'));

            const promise = withRetry(mockFn, {
                attempts: 2,
                baseDelay: 1,
                maxDelay: 10,
                // 故意不传 logger
            });
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(100);

            await expect(promise).rejects.toEqual(
                apiError(500, 'Internal Error'),
            );
            expect(mockFn).toHaveBeenCalledTimes(2);
        });
    });

    // ═══════════════════════════════════════
    // 验收标准 2.4 — 并发安全
    // ═══════════════════════════════════════
    describe('并发安全', () => {
        beforeEach(() => {
            // delay 设为 0，避免真实等待（Math.random → 0 使 jitter = 0）
            vi.spyOn(Math, 'random').mockReturnValue(0);
        });

        it('50 条并发重试不应出现 unhandled rejection 或事件循环阻塞', async () => {
            // 每条任务：第 1 次 429 失败 → 第 2 次成功
            const tasks = Array.from({ length: 50 }, (_, i) => {
                const mockFn = vi
                    .fn()
                    .mockRejectedValueOnce(apiError(429))
                    .mockResolvedValueOnce(`result-${i}`);
                return { mockFn, id: i };
            });

            // 监听 unhandledRejection
            const rejections: unknown[] = [];
            const handler = (reason: unknown) => rejections.push(reason);
            process.on('unhandledRejection', handler);

            // 记录内存基线
            const heapBefore = process.memoryUsage().heapUsed;

            // 事件循环响应检测：setImmediate 应在合理时间内触发
            let eventLoopBlocked = true;
            setImmediate(() => {
                eventLoopBlocked = false;
            });

            // 并发触发 50 条重试
            const results = await Promise.allSettled(
                tasks.map(({ mockFn }) =>
                    withRetry(mockFn, {
                        attempts: 3,
                        baseDelay: 1,
                        maxDelay: 10,
                        logger,
                    }),
                ),
            );

            // 事件循环未被阻塞
            expect(eventLoopBlocked).toBe(false);

            // 无 unhandled rejection
            expect(rejections).toHaveLength(0);
            process.removeListener('unhandledRejection', handler);

            // 全部成功
            const fulfilled = results.filter((r) => r.status === 'fulfilled');
            expect(fulfilled).toHaveLength(50);

            // 验证每条结果正确
            fulfilled.forEach((r, i) => {
                expect((r as PromiseFulfilledResult<string>).value).toBe(
                    `result-${i}`,
                );
            });

            // 验证每条都经历了 1 次重试
            tasks.forEach(({ mockFn }) => {
                expect(mockFn).toHaveBeenCalledTimes(2);
            });

            // 内存检查：增量应在合理范围（< 20MB）
            const heapAfter = process.memoryUsage().heapUsed;
            const heapDelta = (heapAfter - heapBefore) / 1024 / 1024;
            expect(heapDelta).toBeLessThan(20);
        });

        it('50 条全部失败的并发重试也应安全完成，无 unhandled rejection', async () => {
            const tasks = Array.from({ length: 50 }, () =>
                vi.fn().mockRejectedValue(apiError(429)),
            );

            const rejections: unknown[] = [];
            const handler = (reason: unknown) => rejections.push(reason);
            process.on('unhandledRejection', handler);

            const results = await Promise.allSettled(
                tasks.map((fn) =>
                    withRetry(fn, {
                        attempts: 2,
                        baseDelay: 1,
                        maxDelay: 10,
                        logger,
                    }),
                ),
            );

            expect(rejections).toHaveLength(0);
            process.removeListener('unhandledRejection', handler);

            // 全部 rejected（429 重试耗尽后抛出）
            const rejected = results.filter((r) => r.status === 'rejected');
            expect(rejected).toHaveLength(50);

            // 每条都尝试了 2 次
            tasks.forEach((fn) => {
                expect(fn).toHaveBeenCalledTimes(2);
            });
        });
    });
});

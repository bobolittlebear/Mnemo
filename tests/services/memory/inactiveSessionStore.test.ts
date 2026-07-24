/**
 * RedisInactiveSessionStore 单元测试
 *
 * 测试目标：SCAN 遍历 last_active_at key → 反解 sid → 时间戳比对 → 筛超时会话
 * Mock 依赖：redisClient（scan / get）、logger
 * 真实逻辑：parseSessionId、cursor 多批次拼接、超时阈值判断、非法值/缺失值降级
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──
// vi.mock 工厂被提升到文件顶部，所有引用变量必须经 vi.hoisted 声明
const { mockLogger, mockScan, mockGet } = vi.hoisted(() => ({
    mockLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    mockScan: vi.fn(),
    mockGet: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
    default: {
        scan: mockScan,
        get: mockGet,
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => mockLogger,
}));

// ── 引入被测模块（在 Mock 之后）──
import { RedisInactiveSessionStore } from '@/services/memory/inactiveSessionStore';
import { sessionTriggerKeys } from '@/services/memory/trigger/triggerKeys';

const SCAN_PATTERN = `${sessionTriggerKeys('NULL').lastActiveAt.split('NULL').join('*')}`;
// ⇒ 'memory:session:*:last_active_at'

const BASE_NOW = 1_700_000_000_000;

function keyOf(sid: string): string {
    return sessionTriggerKeys(sid).lastActiveAt;
}

/** 构造 scan 批次映射：input cursor → { nextCursor, keys } */
function scriptScan(
    batches: Record<string, { cursor: string; keys: string[] }>,
) {
    mockScan.mockImplementation((cursor: string) =>
        Promise.resolve(batches[cursor]),
    );
}

/** 构造 get 映射：key → value（缺失返回 null） */
function scriptGet(values: Record<string, string | null>) {
    mockGet.mockImplementation((k: string) =>
        Promise.resolve(values[k] ?? null),
    );
}

describe('RedisInactiveSessionStore', () => {
    let store: RedisInactiveSessionStore;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_NOW);
        mockScan.mockReset();
        mockGet.mockReset();
        mockLogger.warn.mockClear();
        store = new RedisInactiveSessionStore();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('超时会话：last_active_at 距今超过 timeoutSec，返回对应 sid', async () => {
        scriptScan({
            '0': {
                cursor: '0',
                keys: [keyOf('sid-timeout')],
            },
        });
        // 距今 2000s，timeoutSec=1800 ⇒ 超时
        scriptGet({
            [keyOf('sid-timeout')]: String(BASE_NOW - 2000 * 1000),
        });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual(['sid-timeout']);
        expect(mockScan).toHaveBeenCalledWith('0', {
            MATCH: SCAN_PATTERN,
            COUNT: 100,
        });
    });

    it('未超时会话：距今小于 timeoutSec，被过滤掉，返回空数组', async () => {
        scriptScan({
            '0': {
                cursor: '0',
                keys: [keyOf('sid-recent')],
            },
        });
        // 距今 100s，timeoutSec=1800 ⇒ 未超时
        scriptGet({
            [keyOf('sid-recent')]: String(BASE_NOW - 100 * 1000),
        });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual([]);
    });

    it('恰好等于阈值（now-ts == threshold）不视为超时（严格大于）', async () => {
        scriptScan({
            '0': { cursor: '0', keys: [keyOf('sid-edge')] },
        });
        // 距今恰好 1800s
        scriptGet({
            [keyOf('sid-edge')]: String(BASE_NOW - 1800 * 1000),
        });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual([]);
    });

    it('多批次 cursor 拼接：scan 以 cursor=0 开始，逐批推进至 0 结束，合并所有 sid', async () => {
        scriptScan({
            '0': { cursor: '10', keys: [keyOf('sid-a'), keyOf('sid-b')] },
            '10': { cursor: '99', keys: [keyOf('sid-c')] },
            '99': { cursor: '0', keys: [keyOf('sid-d')] },
        });
        // 全部距今 5000s ⇒ 均超时
        const oldTs = String(BASE_NOW - 5000 * 1000);
        scriptGet({
            [keyOf('sid-a')]: oldTs,
            [keyOf('sid-b')]: oldTs,
            [keyOf('sid-c')]: oldTs,
            [keyOf('sid-d')]: oldTs,
        });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual(['sid-a', 'sid-b', 'sid-c', 'sid-d']);
        expect(mockScan).toHaveBeenCalledTimes(3);
        expect(mockScan).toHaveBeenNthCalledWith(1, '0', {
            MATCH: SCAN_PATTERN,
            COUNT: 100,
        });
        expect(mockScan).toHaveBeenNthCalledWith(2, '10', {
            MATCH: SCAN_PATTERN,
            COUNT: 100,
        });
        expect(mockScan).toHaveBeenNthCalledWith(3, '99', {
            MATCH: SCAN_PATTERN,
            COUNT: 100,
        });
    });

    it('key 反解：从完整 key 正确提取中间 sid 段（含特殊字符）', async () => {
        const sid = 'abc-123_xyz.7';
        scriptScan({
            '0': { cursor: '0', keys: [keyOf(sid)] },
        });
        scriptGet({ [keyOf(sid)]: String(BASE_NOW - 3000 * 1000) });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual([sid]);
        expect(mockGet).toHaveBeenCalledWith(keyOf(sid));
    });

    it('降级：key 在 SCAN 与 GET 之间被删除（get 返回 null），跳过不抛错', async () => {
        scriptScan({
            '0': { cursor: '0', keys: [keyOf('sid-gone'), keyOf('sid-ok')] },
        });
        scriptGet({
            [keyOf('sid-ok')]: String(BASE_NOW - 3000 * 1000),
            // sid-gone 的 get 默认返回 null
        });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual(['sid-ok']);
    });

    it('降级：时间戳值非法（非数字），跳过并 warn', async () => {
        mockLogger.warn.mockClear();

        scriptScan({
            '0': { cursor: '0', keys: [keyOf('sid-bad')] },
        });
        scriptGet({ [keyOf('sid-bad')]: 'not-a-number' });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'last_active_at 值非法，跳过',
            { sessionId: 'sid-bad', raw: 'not-a-number' },
        );
    });

    it('降级：scan 返回不符合前/后缀格式的 key，parseSessionId 返回 null 被跳过', async () => {
        scriptScan({
            '0': {
                cursor: '0',
                keys: [
                    'memory:session:no-suffix', // 缺后缀
                    'other:session:x:last_active_at', // 前缀不符
                    keyOf('sid-valid'),
                ],
            },
        });
        scriptGet({
            [keyOf('sid-valid')]: String(BASE_NOW - 3000 * 1000),
        });

        const result = await store.findInactiveSessions(1800);

        expect(result).toEqual(['sid-valid']);
    });

    it('SCAN pattern 与 triggerKeys 派生一致：含前缀 memory:session: 与后缀 :last_active_at', () => {
        expect(SCAN_PATTERN).toBe('memory:session:*:last_active_at');
        expect(SCAN_PATTERN.startsWith('memory:session:')).toBe(true);
        expect(SCAN_PATTERN.endsWith(':last_active_at')).toBe(true);
    });
});

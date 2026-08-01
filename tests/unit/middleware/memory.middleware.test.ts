/**
 * memoryMiddleware 单元测试
 *
 * 测试目标：
 *   A1: body 有 sessionId → req.meta.sessionId 取 body 值
 *   A2: 仅 query 有 → req.meta.sessionId 取 query 值
 *   A3: body 和 query 都有 → body 值生效
 *   A4: body 和 query 都无 → req.meta.sessionId === undefined
 *   A5: 任意请求 → res.cookie 未被调用
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖 ──

vi.mock('@/lib/redis', () => ({ default: {} }));
vi.mock('@/lib/logger', () => {
    const shared = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    return { createLogger: vi.fn(() => shared) };
});

// ── 被测试模块 ──
import { memoryMiddleware } from '@/middleware/memory.middleware';

/** 构造最小合规的 req/res/next mock */
function makeMocks(overrides?: {
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
}) {
    const req = {
        body: overrides?.body ?? {},
        query: overrides?.query ?? {},
        meta: undefined as { sessionId?: string } | undefined,
    } as unknown as Parameters<typeof memoryMiddleware>[0];

    const res = {
        cookie: vi.fn(),
    } as unknown as Parameters<typeof memoryMiddleware>[1];

    const next = vi.fn() as Parameters<typeof memoryMiddleware>[2];

    return { req, res, next };
}

beforeEach(() => {
    // nothing to reset — no shared state
});

// ── 测试用例 ──

describe('memoryMiddleware', () => {
    it('A1: body 有 sessionId → req.meta.sessionId 取 body 值', () => {
        const { req, res, next } = makeMocks({
            body: { sessionId: 'sid_in_body' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.sessionId).toBe('sid_in_body');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('A2: 仅 query 有 sessionId → req.meta.sessionId 取 query 值', () => {
        const { req, res, next } = makeMocks({
            query: { sessionId: 'sid_in_query' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.sessionId).toBe('sid_in_query');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('A3: body 和 query 都有 sessionId → body 值生效', () => {
        const { req, res, next } = makeMocks({
            body: { sessionId: 'body_wins' },
            query: { sessionId: 'query_loses' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.sessionId).toBe('body_wins');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('A4: body 和 query 都无 sessionId → req.meta.sessionId === undefined', () => {
        const { req, res, next } = makeMocks({});

        memoryMiddleware(req, res, next);

        expect(req.meta.sessionId).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('A5: 任意请求 → res.cookie 未被调用', () => {
        const { req, res, next } = makeMocks({
            body: { sessionId: 'some-id' },
        });

        memoryMiddleware(req, res, next);

        expect(res.cookie).not.toHaveBeenCalled();
    });
});

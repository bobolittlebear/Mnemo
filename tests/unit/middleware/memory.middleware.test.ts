/**
 * memoryMiddleware 单元测试
 *
 * 测试目标：
 *   A1: body 有 sessionId → req.meta.sessionId 取 body 值
 *   A2: 仅 query 有 → req.meta.sessionId 取 query 值
 *   A3: body 和 query 都有 → body 值生效
 *   A4: body 和 query 都无 → req.meta.sessionId === undefined
 *   A5: 任意请求 → res.cookie 未被调用
 *   C1: 写模式带 runId → 三个字段全取自 body，不重新 mint
 *   C2: 写模式无 runId → 中间件 mint（32 位十六进制）
 *   C3: chat 模式 → noteId/runId 强制 undefined（body 带了也忽略）
 *   C4: body.mode 非法 → mode === 'chat'（失败关闭）
 *   C5: body 完全无 mode/noteId/runId → 默认 chat，两个作用域字段均 undefined
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

type MiddlewareRequest = Parameters<typeof memoryMiddleware>[0];

/** 构造最小合规的 req/res/next mock */
function makeMocks(overrides?: {
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
}) {
    const req = {
        body: overrides?.body ?? {},
        query: overrides?.query ?? {},
        meta: undefined as MiddlewareRequest['meta'] | undefined,
    } as unknown as MiddlewareRequest;

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
            body: { session_id: 'sid_in_body' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.sessionId).toBe('sid_in_body');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('A2: 仅 query 有 sessionId → req.meta.sessionId 取 query 值', () => {
        const { req, res, next } = makeMocks({
            query: { session_id: 'sid_in_query' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.sessionId).toBe('sid_in_query');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('A3: body 和 query 都有 sessionId → body 值生效', () => {
        const { req, res, next } = makeMocks({
            body: { session_id: 'body_wins' },
            query: { session_id: 'query_loses' },
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
            body: { session_id: 'some-id' },
        });

        memoryMiddleware(req, res, next);

        expect(res.cookie).not.toHaveBeenCalled();
    });
});

// ── M-C2：上下文域（mode/noteId/runId）统一注入 req.meta ──

describe('memoryMiddleware — 上下文域注入', () => {
    it('C1: 写模式带 runId → meta 三个字段全取自 body，未重新 mint', () => {
        const { req, res, next } = makeMocks({
            body: {
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
                session_id: 's1',
            },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta).toEqual({
            sessionId: 's1',
            mode: 'write',
            noteId: 'n1',
            runId: 'r1',
        });
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('C2: 写模式无 runId → 中间件 mint（crypto 32 位十六进制，非 body 值）', () => {
        const { req, res, next } = makeMocks({
            body: { mode: 'write', noteId: 'n1' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.mode).toBe('write');
        expect(req.meta.noteId).toBe('n1');
        expect(typeof req.meta.runId).toBe('string');
        expect(req.meta.runId).toMatch(/^[0-9a-f]{32}$/);
        expect(req.meta.runId).not.toBe('r1');
    });

    it('C3: chat 模式 → noteId/runId 强制 undefined（body 带了也忽略）', () => {
        const { req, res, next } = makeMocks({
            body: {
                mode: 'chat',
                noteId: 'n1',
                runId: 'r1',
                session_id: 's1',
            },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.mode).toBe('chat');
        expect(req.meta.sessionId).toBe('s1');
        expect(req.meta.noteId).toBeUndefined();
        expect(req.meta.runId).toBeUndefined();
    });

    it('C4: body.mode 非法（foo）→ mode 回落 chat（失败关闭，不启用工具）', () => {
        const { req, res, next } = makeMocks({
            body: { mode: 'foo', noteId: 'n1', runId: 'r1' },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.mode).toBe('chat');
        expect(req.meta.noteId).toBeUndefined();
        expect(req.meta.runId).toBeUndefined();
    });

    it('C5: body 无 mode/noteId/runId → 默认 chat，作用域字段均 undefined', () => {
        const { req, res, next } = makeMocks({});

        memoryMiddleware(req, res, next);

        expect(req.meta.mode).toBe('chat');
        expect(req.meta.noteId).toBeUndefined();
        expect(req.meta.runId).toBeUndefined();
    });

    it('C6: 写模式但 noteId/runId 非字符串 → 视为未带（不落脏值）', () => {
        const { req, res, next } = makeMocks({
            body: { mode: 'write', noteId: 123, runId: 456 },
        });

        memoryMiddleware(req, res, next);

        expect(req.meta.mode).toBe('write');
        expect(req.meta.noteId).toBeUndefined();
        // 非法 runId 未沿用，回落到 mint 值
        expect(req.meta.runId).toMatch(/^[0-9a-f]{32}$/);
    });
});

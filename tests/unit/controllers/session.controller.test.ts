/**
 * POST /api/session 控制器单元测试
 *
 * 测试目标：
 *   ① 正常 {sessionId, userId} → set 被调用，key/value/选项正确
 *   ② userId 缺失 → 401，set 不被调用
 *   ③ sessionId 缺失/非法字符 → 400
 *   ④ NX 幂等：验证 set 第三参为 'NX'
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖 ──

const { mockRedisSet } = vi.hoisted(() => ({
    mockRedisSet: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
    default: {
        set: mockRedisSet,
        get: vi.fn(),
    },
}));

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
// ── Mock Session Model ──

const {
    mockSessionLean,
    mockSessionFind,
    mockSessionFindOne,
    mockSessionFindOneLean,
} = vi.hoisted(() => ({
    mockSessionLean: vi.fn(),
    mockSessionFind: vi.fn(),
    mockSessionFindOne: vi.fn(),
    mockSessionFindOneLean: vi.fn(),
}));

const mockSessionSelect = vi.fn(() => ({ lean: mockSessionLean }));
const mockSessionSort = vi.fn(() => ({ select: mockSessionSelect }));
const mockSessionFindOneSelect = vi.fn(() => ({
    lean: mockSessionFindOneLean,
}));

vi.mock('@/models/Session', () => ({
    default: {
        find: mockSessionFind,
        findOne: mockSessionFindOne,
    },
}));

// 让 find().sort().select().lean() 链式调用连通（与控制器链一致）
mockSessionFind.mockReturnValue({
    sort: mockSessionSort,
});
mockSessionFindOne.mockReturnValue({
    select: mockSessionFindOneSelect,
});

import { createSession, getSessions } from '@/controllers/session.controller';

/** 构造最小合规的 req/res mock */
function makeReqRes(overrides?: {
    body?: Record<string, unknown>;
    userId?: string;
}) {
    const req = {
        body: overrides?.body ?? {},
        user: overrides?.userId ? { userId: overrides.userId } : undefined,
    } as unknown as Parameters<typeof createSession>[0];

    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Parameters<typeof createSession>[1];

    return { req, res };
}

beforeEach(() => {
    mockRedisSet.mockReset();
    mockRedisSet.mockResolvedValue('OK');
});

// ── 测试用例 ──

describe('createSession', () => {
    it('正常写入映射：set 使用正确参数 key=session:user:{sid}, value=userId, NX, EX', async () => {
        const { req, res } = makeReqRes({
            body: { sessionId: 'abc-123_XYZ' },
            userId: 'user-1',
        });

        await createSession(req, res);

        expect(mockRedisSet).toHaveBeenCalledTimes(1);
        expect(mockRedisSet).toHaveBeenCalledWith(
            'session:user:abc-123_XYZ',
            'user-1',
            { NX: true, EX: 60 * 60 * 24 * 30 },
        );

        // 返回 200 { ok: true }
        expect(res.status).toHaveBeenCalledWith(200);
        const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock
            .calls[0]![0];
        expect(jsonArg.success).toBe(true);
        expect(jsonArg.data).toEqual({ ok: true });
    });

    it('userId 缺失 → 401 且 set 不被调用', async () => {
        const { req, res } = makeReqRes({ body: { sessionId: 'sid-1' } });
        // req.user 为 undefined，userId 缺失

        await createSession(req, res);

        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('sessionId 缺失 → 400', async () => {
        const { req, res } = makeReqRes({ body: {}, userId: 'user-1' });

        await createSession(req, res);

        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('sessionId 含非法字符（空格）→ 400', async () => {
        const { req, res } = makeReqRes({
            body: { sessionId: 'bad id' },
            userId: 'user-1',
        });

        await createSession(req, res);

        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('sessionId 含非法字符（斜杠）→ 400', async () => {
        const { req, res } = makeReqRes({
            body: { sessionId: 'bad/sid' },
            userId: 'user-1',
        });

        await createSession(req, res);

        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('sessionId 含非法字符（冒号，防 key 注入）→ 400', async () => {
        const { req, res } = makeReqRes({
            body: { sessionId: 'evil:key' },
            userId: 'user-1',
        });

        await createSession(req, res);

        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('NX 幂等性：重复调用同一 sessionId 仍正确传参 NX（不覆盖）', async () => {
        const { req, res } = makeReqRes({
            body: { sessionId: 'stable-id' },
            userId: 'user-A',
        });

        await createSession(req, res);

        expect(mockRedisSet).toHaveBeenCalledWith(
            'session:user:stable-id',
            'user-A',
            { NX: true, EX: 60 * 60 * 24 * 30 },
        );

        // 第二次调用，不同 userId 传入 → NX 保证不覆盖，原值保留
        mockRedisSet.mockReset();
        mockRedisSet.mockResolvedValue(null); // Redis NX 返回 null 表示 key 已存在

        const { req: req2, res: res2 } = makeReqRes({
            body: { sessionId: 'stable-id' },
            userId: 'user-B',
        });

        await createSession(req2, res2);

        // 第二次仍然传 NX，Redis 侧会拒绝覆盖
        expect(mockRedisSet).toHaveBeenCalledWith(
            'session:user:stable-id',
            'user-B',
            { NX: true, EX: 60 * 60 * 24 * 30 },
        );
    });

    it('sessionId 非字符串类型 → 400', async () => {
        const { req, res } = makeReqRes({
            body: { sessionId: 12345 },
            userId: 'user-1',
        });

        await createSession(req, res);

        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('Redis set 抛异常 → 500', async () => {
        mockRedisSet.mockRejectedValue(new Error('Redis 连接失败'));

        const { req, res } = makeReqRes({
            body: { sessionId: 'sid-err' },
            userId: 'user-1',
        });

        await createSession(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

// ── getSessions 测试 ──

/** 构造 getSessions 的 req/res mock */
function makeGetSessionsReqRes(overrides?: {
    userId?: string;
    query?: Record<string, unknown>;
}) {
    const req = {
        query: overrides?.query ?? {},
        user: overrides?.userId ? { userId: overrides.userId } : undefined,
    } as unknown as Parameters<typeof getSessions>[0];

    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Parameters<typeof getSessions>[1];

    return { req, res };
}

/** 构造假的 Session 文档 */
function makeSessionDoc(
    sessionId: string,
    overrides?: { title?: string; status?: string },
) {
    return {
        sessionId,
        title: overrides?.title ?? '测试会话',
        status: overrides?.status ?? 'active',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
    };
}

describe('getSessions', () => {
    beforeEach(() => {
        mockSessionFind.mockReset();
        mockSessionFindOne.mockReset();
        mockSessionLean.mockReset();
        mockSessionFindOneLean.mockReset();
        mockSessionSort.mockReset();
        mockSessionSelect.mockReset();

        // 重建链式调用：find → sort → select → lean（与控制器一致）
        mockSessionFind.mockReturnValue({
            sort: mockSessionSort,
        });
        mockSessionSort.mockReturnValue({
            select: mockSessionSelect,
        });
        mockSessionSelect.mockReturnValue({
            lean: mockSessionLean,
        });
        mockSessionFindOne.mockReturnValue({
            select: mockSessionFindOneSelect,
        });
        mockSessionFindOneSelect.mockReturnValue({
            lean: mockSessionFindOneLean,
        });
    });

    it('B1: 库里有 3 active + 2 archived → find filter 含 { userId, status: "active" }，返回 3 条', async () => {
        const activeDocs = [
            makeSessionDoc('s1'),
            makeSessionDoc('s2'),
            makeSessionDoc('s3'),
        ];
        mockSessionLean.mockResolvedValue(activeDocs);

        const { req, res } = makeGetSessionsReqRes({
            userId: 'u1',
        });

        await getSessions(req, res);

        // 验证 find 的 filter
        expect(mockSessionFind).toHaveBeenCalledTimes(1);
        const filterArg = mockSessionFind.mock.calls[0]![0] as Record<
            string,
            unknown
        >;
        expect(filterArg.userId).toBe('u1');
        expect(filterArg.status).toBe('active');

        // 验证返回
        expect(res.json).toHaveBeenCalledTimes(1);
        const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock
            .calls[0]![0] as { success: boolean; data: { list: unknown[] } };
        expect(jsonArg.success).toBe(true);
        expect(jsonArg.data.list).toHaveLength(3);
    });

    it('B2: 用户无 active 会话 → 返回 { list: [] }', async () => {
        mockSessionLean.mockResolvedValue([]);

        const { req, res } = makeGetSessionsReqRes({ userId: 'u2' });

        await getSessions(req, res);

        const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock
            .calls[0]![0] as { success: boolean; data: { list: unknown[] } };
        expect(jsonArg.success).toBe(true);
        expect(jsonArg.data.list).toEqual([]);
    });

    it('B3: 验证 sort 按 lastActiveAt 倒序排列', async () => {
        mockSessionLean.mockResolvedValue([]);

        const { req, res } = makeGetSessionsReqRes({ userId: 'u1' });

        await getSessions(req, res);

        expect(mockSessionSort).toHaveBeenCalledWith({
            lastActiveAt: -1,
        });
    });

    it('B4: 验证 select 仅投影指定字段（sessionId title createdAt lastActiveAt）', async () => {
        mockSessionLean.mockResolvedValue([]);

        const { req, res } = makeGetSessionsReqRes({ userId: 'u1' });

        await getSessions(req, res);

        expect(mockSessionSelect).toHaveBeenCalledWith(
            'sessionId title createdAt lastActiveAt',
        );
    });
});

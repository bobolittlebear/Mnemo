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
import { createSession } from '@/controllers/session.controller';

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

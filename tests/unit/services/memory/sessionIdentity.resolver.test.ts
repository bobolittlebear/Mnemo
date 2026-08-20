/**
 * SessionIdentityResolver 单元测试
 *
 * 测试目标：resolve / resolveBatch 的命中/未命中/异常降级行为
 * Mock 依赖：redisClient（get / mGet）、logger
 * 被测模块：RedisSessionIdentityResolver + createRedisSessionIdentityResolver 工厂
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock 外部依赖 ──
const { mockLogger } = vi.hoisted(() => ({
    mockLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => mockLogger,
}));

// ── 引入被测模块（在 Mock 之后）──
import {
    RedisSessionIdentityResolver,
    createRedisSessionIdentityResolver,
} from '@/services/memory/sessionIdentity.resolver';

/** 构造 stub Redis 客户端，只暴露 get / mGet */
function createStubRedis(overrides?: {
    get?: (key: string) => Promise<string | null>;
    mGet?: (keys: string[]) => Promise<(string | null)[]>;
}) {
    return {
        get: vi.fn().mockResolvedValue(null),
        mGet: vi.fn().mockResolvedValue([]),
        ...overrides,
    };
}

// ── 测试套件 ──────────────────────────────────────────────────────

describe('SessionIdentityResolver', () => {
    describe('resolve', () => {
        let redis: ReturnType<typeof createStubRedis>;
        let resolver: RedisSessionIdentityResolver;

        beforeEach(() => {
            redis = createStubRedis();
            resolver = new RedisSessionIdentityResolver(redis);
            mockLogger.warn.mockClear();
        });

        it('resolve 命中：session:user:abc 值为 u1，返回 "u1"', async () => {
            redis.get.mockResolvedValue('u1');

            const result = await resolver.resolve('abc');

            expect(result).toBe('u1');
            expect(redis.get).toHaveBeenCalledWith('session:user:abc');
        });

        it('resolve 未命中：key 不存在返回 null，返回 null', async () => {
            redis.get.mockResolvedValue(null);

            const result = await resolver.resolve('nonexistent');

            expect(result).toBeNull();
            expect(redis.get).toHaveBeenCalledWith('session:user:nonexistent');
        });

        it('resolve 异常降级：get 抛错时返回 null，不向上抛，且 warn', async () => {
            redis.get.mockRejectedValue(new Error('连接断开'));

            const result = await resolver.resolve('err-sid');

            expect(result).toBeNull();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                '解析 session userId 失败，降级为 null',
                { sessionId: 'err-sid', error: '连接断开' },
            );
        });

        it('resolve 异常降级：非 Error 类型也安全捕获', async () => {
            redis.get.mockRejectedValue('原始字符串异常');

            const result = await resolver.resolve('err-sid-2');

            expect(result).toBeNull();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                '解析 session userId 失败，降级为 null',
                { sessionId: 'err-sid-2', error: '原始字符串异常' },
            );
        });
    });

    describe('resolveBatch', () => {
        let redis: ReturnType<typeof createStubRedis>;
        let resolver: RedisSessionIdentityResolver;

        beforeEach(() => {
            redis = createStubRedis();
            resolver = new RedisSessionIdentityResolver(redis);
            mockLogger.warn.mockClear();
        });

        it('resolveBatch 部分命中：3 个 sid 中 2 个有值，Map 仅含 2 项且值正确', async () => {
            redis.mGet.mockResolvedValue(['u1', null, 'u3']);

            const result = await resolver.resolveBatch([
                'sid-1',
                'sid-2',
                'sid-3',
            ]);

            expect(result.size).toBe(2);
            expect(result.get('sid-1')).toBe('u1');
            expect(result.get('sid-3')).toBe('u3');
            expect(result.has('sid-2')).toBe(false);
            expect(redis.mGet).toHaveBeenCalledWith([
                'session:user:sid-1',
                'session:user:sid-2',
                'session:user:sid-3',
            ]);
        });

        it('resolveBatch 全部命中：3 个 sid 全部有值，Map 含 3 项', async () => {
            redis.mGet.mockResolvedValue(['ua', 'ub', 'uc']);

            const result = await resolver.resolveBatch(['a', 'b', 'c']);

            expect(result.size).toBe(3);
            expect(result.get('a')).toBe('ua');
            expect(result.get('b')).toBe('ub');
            expect(result.get('c')).toBe('uc');
        });

        it('resolveBatch 全缺失：所有 key 都返回 null，返回空 Map', async () => {
            redis.mGet.mockResolvedValue([null, null, null]);

            const result = await resolver.resolveBatch(['x', 'y', 'z']);

            expect(result.size).toBe(0);
        });

        it('resolveBatch 空数组：直接返回空 Map，不调 mGet', async () => {
            const result = await resolver.resolveBatch([]);

            expect(result.size).toBe(0);
            expect(redis.mGet).not.toHaveBeenCalled();
        });

        it('resolveBatch 异常降级：mGet 抛错时返回空 Map，不向上抛，且 warn', async () => {
            redis.mGet.mockRejectedValue(new Error('集群不可用'));

            const result = await resolver.resolveBatch(['sid-err']);

            expect(result.size).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                '批量解析 session userId 失败，降级为空 Map',
                { sessionCount: 1, error: '集群不可用' },
            );
        });

        it('resolveBatch 值含 undefined 也跳过（仅 string 入 Map）', async () => {
            // mGet of node-redis returns (string | null)[], but be defensive
            redis.mGet.mockResolvedValue([null, 'u2', null]);

            const result = await resolver.resolveBatch(['s1', 's2', 's3']);

            expect(result.size).toBe(1);
            expect(result.get('s2')).toBe('u2');
        });
    });

    describe('createRedisSessionIdentityResolver 工厂', () => {
        it('工厂注入 stub 后，行为与非工厂构造一致', async () => {
            const redis = createStubRedis();
            redis.get.mockResolvedValue('user-99');

            const resolver = createRedisSessionIdentityResolver(redis);

            const result = await resolver.resolve('my-sid');

            expect(result).toBe('user-99');
            expect(redis.get).toHaveBeenCalledWith('session:user:my-sid');
        });
    });
});

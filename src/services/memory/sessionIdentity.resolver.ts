import { createLogger } from '@/lib/logger';

const log = createLogger('ltm');

// ── 接口（核心域只依赖此接口，不依赖 Redis 实现）──────────────────────

/**
 * 会话身份解析器 —— 按 sessionId 解析归属 userId。
 *
 * 核心域（MemoryPipeline 等）通过此接口获取 userId，无需直接依赖 Redis。
 * 写入端（M3）使用 `session:user:{sid}` 写入 userId，本解析器仅负责读取。
 */
export interface SessionIdentityResolver {
    /** 按 sessionId 解析 userId，查不到返回 null，异常降级也返回 null */
    resolve(sessionId: string): Promise<string | null>;

    /** 批量解析，仅命中项入 Map（可选的便利方法） */
    resolveBatch?(sessionIds: string[]): Promise<Map<string, string>>;
}

// ── Redis 实现 ────────────────────────────────────────────────────

const SESSION_USER_PREFIX = 'session:user:';

function sessionUserKey(sessionId: string): string {
    return `${SESSION_USER_PREFIX}${sessionId}`;
}

/**
 * 基于 Redis 的会话身份解析器实现。
 *
 * - resolve: GET `session:user:{sid}`，命中返字符串，未命中或异常返 null
 * - resolveBatch: 一次 mGet 取全部，仅含命中项组装 Map
 *
 * TTL 由写入端（M3）控制（SET ... NX EX ttl），读端不关心。
 */
export class RedisSessionIdentityResolver implements SessionIdentityResolver {
    private readonly redis: { get: (key: string) => Promise<string | null>; mGet: (keys: string[]) => Promise<(string | null)[]> };

    constructor(redis: { get: (key: string) => Promise<string | null>; mGet: (keys: string[]) => Promise<(string | null)[]> }) {
        this.redis = redis;
    }

    async resolve(sessionId: string): Promise<string | null> {
        try {
            const value = await this.redis.get(sessionUserKey(sessionId));
            return value ?? null;
        } catch (error) {
            log.warn('解析 session userId 失败，降级为 null', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    async resolveBatch(sessionIds: string[]): Promise<Map<string, string>> {
        if (sessionIds.length === 0) {
            return new Map();
        }

        const keys = sessionIds.map((sid) => sessionUserKey(sid));

        try {
            const values = await this.redis.mGet(keys);
            const result = new Map<string, string>();
            for (let i = 0; i < sessionIds.length; i++) {
                const value = values[i];
                if (value !== null && value !== undefined) {
                    result.set(sessionIds[i]!, value);
                }
            }
            return result;
        } catch (error) {
            log.warn('批量解析 session userId 失败，降级为空 Map', {
                sessionCount: sessionIds.length,
                error: error instanceof Error ? error.message : String(error),
            });
            return new Map();
        }
    }
}

// ── 工厂 ──────────────────────────────────────────────────────────

/**
 * 创建 Redis 会话身份解析器实例。
 *
 * 用于组合根（src/services/memory/index.ts）或测试注入 stub。
 */
export function createRedisSessionIdentityResolver(
    redis: { get: (key: string) => Promise<string | null>; mGet: (keys: string[]) => Promise<(string | null)[]> },
): RedisSessionIdentityResolver {
    return new RedisSessionIdentityResolver(redis);
}

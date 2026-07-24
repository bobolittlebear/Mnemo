import { createLogger } from '@/lib/logger';
import redisClient from '@/lib/redis';
import type { InactiveSessionStore } from './trigger/sessionTimeoutScanner';
import { sessionTriggerKeys } from './trigger/triggerKeys';

const log = createLogger('ltm');

/**
 * 反解 last_active_at key 得到 sessionId。
 *
 * 前缀/后缀从 sessionTriggerKeys 派生，避免与 triggerKeys.ts 各自硬编码导致漂移：
 *   sessionTriggerKeys(SID).lastActiveAt === `memory:session:${SID}:last_active_at`
 *   ⇒ PREFIX = 'memory:session:', SUFFIX = ':last_active_at'
 */
const _SID_PLACEHOLDER = 'NULL';
const _TEMPLATE = sessionTriggerKeys(_SID_PLACEHOLDER).lastActiveAt;
const [PREFIX, SUFFIX] = _TEMPLATE.split(_SID_PLACEHOLDER);

function parseSessionId(key: string): string | null {
    if (!key.startsWith(PREFIX!) || !key.endsWith(SUFFIX!)) {
        return null;
    }
    return key.slice(PREFIX!.length, key.length - SUFFIX!.length);
}

/**
 * 基于 Redis 的不活跃会话存储实现。
 *
 * 通过 SCAN 遍历所有 `memory:session:*:last_active_at` 键，比对时间戳，
 * 筛出超过 timeoutSec 未活跃的 sessionId，供 L2 超时扫描使用。
 *
 * 使用 SCAN 而非 KEYS，避免阻塞 Redis；SCAN 遍历期间对单个 key 单独 GET，
 * 容忍并发写入带来的轻微漂移。
 */
export class RedisInactiveSessionStore implements InactiveSessionStore {
    /**
     * @param timeoutSec 超时秒数，last_active_at 距今超过该值即视为不活跃
     * @returns 不活跃的 sessionId 数组
     */
    async findInactiveSessions(timeoutSec: number): Promise<string[]> {
        const thresholdMs = timeoutSec * 1000;
        const now = Date.now();
        const pattern = `${PREFIX}*${SUFFIX}`;
        const inactiveSids: string[] = [];

        let cursor: string = '0';
        do {
            // node-redis v6: scan 返回 { cursor, keys }（非 v4 的元组）
            const { cursor: nextCursor, keys } = await redisClient.scan(
                cursor,
                {
                    MATCH: pattern,
                    COUNT: 100,
                },
            );
            cursor = nextCursor;

            for (const key of keys) {
                const sid = parseSessionId(key);
                if (sid === null) {
                    continue;
                }

                const raw = await redisClient.get(key);
                if (raw === null) {
                    // key 在 SCAN 与 GET 之间被删除，跳过
                    continue;
                }

                const ts = Number(raw);
                if (!Number.isFinite(ts)) {
                    log.warn('last_active_at 值非法，跳过', {
                        sessionId: sid,
                        raw,
                    });
                    continue;
                }

                if (now - ts > thresholdMs) {
                    inactiveSids.push(sid);
                }
            }
        } while (cursor !== '0');

        return inactiveSids;
    }
}

export default new RedisInactiveSessionStore();

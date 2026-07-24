/**
 * RedisInactiveSessionStore 集成冒烟测试
 *
 * 真实 Redis，验证 SCAN + 时间戳比对端到端正确：
 *   - 超时会话被返回
 *   - 近期会话被排除
 *   - 多会话混合时只返回超时者
 *
 * 运行前提：
 *   1. Redis 已启动（本地或 REDIS_URL 可连）
 *
 * 运行命令：pnpm test:integration
 *
 * 注意：集成测试会真实写 Redis，每个用例前后自动清理自有 key。
 * SCAN 扫描全局 `memory:session:*:last_active_at`，可能命中其他会话的 key，
 * 故用唯一 sid 前缀 + include/notContain 断言隔离，不做整体数组相等断言。
 */

// ── Mock logger（避免真实写文件噪音，与现有集成测试一致）──
import { vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// ── 正式导入（Mock 已注入）──
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import redisClient from '@/lib/redis';
import inactiveSessionStore from '@/services/memory/inactiveSessionStore';
import { sessionTriggerKeys } from '@/services/memory/trigger/triggerKeys';

// ── 测试数据：唯一前缀，避免与其他会话/测试运行冲突 ──
const SID_OLD = '__inttest_inactive__old';
const SID_RECENT = '__inttest_inactive__recent';
const TEST_SIDS = [SID_OLD, SID_RECENT];

function keyOf(sid: string): string {
    return sessionTriggerKeys(sid).lastActiveAt;
}

async function cleanupTestKeys() {
    await redisClient.del(TEST_SIDS.map(keyOf));
}

beforeAll(async () => {
    // redis.ts 在 import 时已自动 connect（IIFE），这里兜底确保连接就绪
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
    await redisClient.ping();
});

afterAll(async () => {
    await cleanupTestKeys();
});

beforeEach(async () => {
    await cleanupTestKeys();
});

describe('RedisInactiveSessionStore 集成冒烟', () => {
    it('INT1 - 超时会话：last_active_at 距今 > timeoutSec，被返回', async () => {
        // 距今 2000s，timeoutSec=1800 ⇒ 超时
        await redisClient.set(
            keyOf(SID_OLD),
            String(Date.now() - 2000 * 1000),
        );

        const result = await inactiveSessionStore.findInactiveSessions(1800);

        expect(result).toContain(SID_OLD);
    });

    it('INT2 - 近期会话：last_active_at 距今 < timeoutSec，被排除', async () => {
        // 距今 100s，timeoutSec=1800 ⇒ 未超时
        await redisClient.set(
            keyOf(SID_RECENT),
            String(Date.now() - 100 * 1000),
        );

        const result = await inactiveSessionStore.findInactiveSessions(1800);

        expect(result).not.toContain(SID_RECENT);
    });

    it('INT3 - 混合：同批存在超时与未超时会话，只返回超时者', async () => {
        await redisClient.set(
            keyOf(SID_OLD),
            String(Date.now() - 5000 * 1000),
        );
        await redisClient.set(
            keyOf(SID_RECENT),
            String(Date.now() - 10 * 1000),
        );

        const result = await inactiveSessionStore.findInactiveSessions(1800);

        expect(result).toContain(SID_OLD);
        expect(result).not.toContain(SID_RECENT);
    });

    it('INT4 - key 不存在时：findInactiveSessions 不抛错，返回数组（可能为空或仅含其他会话）', async () => {
        // 不写任何自有 key
        await expect(inactiveSessionStore.findInactiveSessions(1800)).resolves.toBeInstanceOf(Array);
    });
});

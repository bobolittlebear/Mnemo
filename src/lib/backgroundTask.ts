// src/lib/backgroundTask.ts
/**
 * 后台定时任务的统一失败兜底封装。
 *
 * 三条链（遗忘扫描 / 笔记增量重建 / L2 超时扫描）都跑在低峰期，共同风险一致：
 * - 开工时 MongoDB 连接可能已被 Atlas 回收，`bufferCommands: false` 下首个查询
 *   立即抛错而非等待重连；
 * - 单轮失败即错过本轮（遗忘扫描要等次日 03:00，reindex 由 20s 轮询自愈）。
 *
 * 连接恢复不在这里做探针：driver 会自行重连，连接不可用表现为首个查询抛错，
 * 与其它瞬态故障走同一条重试路径（`withRetry` + driver 自愈）。这里只把
 * 「业务重试 → 兜底不抛」收敛到一处：新增后台任务直接复用，不必再各写一份
 * `readyState` 判断。
 *
 * 日志 tag 用 `code`：跨模块基础设施，不归属单一业务模块（spec 的 10 个 tag 里
 * 没有 background，`code` 是既有的正交兜底位）。
 */
import { createLogger } from '@/lib/logger';
import { withRetry } from '@/lib/retry';

const log = createLogger('code');

export interface GuardedTaskOptions {
    /** withRetry 的总尝试次数（含首次），默认 2 → 1 次初始 + 1 次重试 */
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
}

/**
 * 带重试的后台任务执行器。
 *
 * **永不抛出**：`fn` 重试耗尽（含连接不可用导致的瞬态失败）返回 `null` 表示
 * 「本轮未执行」，调用方无需再包 try/catch（后台链路的下一步排期不该被单轮
 * 失败打断）。
 *
 * 注意 `fn` 应当是「整轮」而非「单条」的粒度：重试会整轮重跑，故 `fn` 内部
 * 对单条数据的处理要自带兜底（如 reindex 的 processOne 死信计数）。
 */
export async function runGuardedTask<T>(
    taskName: string,
    fn: () => Promise<T>,
    opts: GuardedTaskOptions = {},
): Promise<T | null> {
    const startTime = Date.now();

    try {
        return await withRetry(fn, {
            attempts: opts.retries ?? 2,
            baseDelay: opts.baseDelayMs ?? 2_000,
            maxDelay: opts.maxDelayMs ?? 8_000,
            logger: log,
        });
    } catch (error) {
        // 重试已由 withRetry 负责（含指数退避 + 全抖动），这里只兜底记录并放行
        log.error('后台任务本轮失败，重试已耗尽', {
            error,
            task: taskName,
            duration_ms: Date.now() - startTime,
        });
        return null;
    }
}

export default runGuardedTask;

import type { DistributedLock } from './distributedLock';
import type { TerminalStateManager } from './terminalStateManager';
import type { ProcessingGuard, TriggerLayer } from './processingGuard';

export interface CoordinatorMetrics {
    count: (name: string, tags?: Record<string, string>) => void;
}

export interface CoordinatorDeps {
    lock: DistributedLock;
    terminal: TerminalStateManager;
    processing: ProcessingGuard;
    pipeline: { run: (sessionId: string) => Promise<void> };
    metrics?: CoordinatorMetrics;
}

/**
 * 触发器拦截阀门
 */
const SKIP_REASON = {
    LOCK: 'LOCK',
    TERMINAL: 'TERMINAL',
    PROCESSING: 'PROCESSING',
} as const;
export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

export type TriggerResult =
    | { status: 'COMPLETED'; terminalWritten: boolean }
    | { status: 'SKIPPED'; reason: SkipReason };

const LOCK_PREFIX = 'memory:lock:';
const P3_RETRIES = 3;
const P3_RETRY_DELAY_MS = 1000;
const METRIC_LABEL_LTM_SKIP = 'ltm.skip';
const METRIC_LABEL_LTM_P3_RETRY = 'ltm.p3.retry';

/**
 * 记忆提取触发协调器
 * - 终态标记管理
 * - processing 防并发
 * - 分布式
 */
export class MemoryTriggerCoordinator {
    constructor(private readonly deps: CoordinatorDeps) {}

    async triggerThreshold(sessionId: string): Promise<TriggerResult> {
        return this.runExtraction(sessionId, 'threshold');
    }

    async executeTerminalTrigger(
        sessionId: string,
        layer: 'explicit' | 'timeout',
    ): Promise<TriggerResult> {
        return this.runExtraction(sessionId, layer);
    }

    private async runExtraction(
        sessionId: string,
        layer: TriggerLayer,
    ): Promise<TriggerResult> {
        const { lock, terminal, processing, pipeline, metrics } = this.deps;
        const lockKey = `${LOCK_PREFIX}${sessionId}`;
        const count = (name: string, tags?: Record<string, string>) =>
            metrics?.count(name, tags);

        // Phase 1：短锁，终态/processing 校验 + 设 processing
        const token = await lock.acquire(lockKey); // 获取锁
        if (!token) {
            // 获取锁失败, 跳过
            count(METRIC_LABEL_LTM_SKIP, { reason: SKIP_REASON.LOCK });
            return { status: 'SKIPPED', reason: SKIP_REASON.LOCK };
        }
        if (await terminal.isExtracted(sessionId)) {
            // 终态标记结束, 释放锁并跳过提取
            await lock.release(lockKey, token);
            count(METRIC_LABEL_LTM_SKIP, { reason: SKIP_REASON.TERMINAL });
            return { status: 'SKIPPED', reason: SKIP_REASON.TERMINAL };
        }
        if (await processing.current(sessionId)) {
            // 已被抢占,正在提取, 跳过
            await lock.release(lockKey, token);
            count(METRIC_LABEL_LTM_SKIP, { reason: SKIP_REASON.PROCESSING });
            return { status: 'SKIPPED', reason: SKIP_REASON.PROCESSING };
        }
        await processing.trySet(sessionId, layer);
        await lock.release(lockKey, token);

        // Phase 2：无锁，Pipeline 自管游标
        try {
            await pipeline.run(sessionId);
        } catch (e) {
            await processing.clear(sessionId);
            throw e;
        } finally {
            await processing.clear(sessionId);
        }

        // Phase 3：短锁带重试，二次终态校验 + 写终态(L1/L2) + 清 processing
        let token3: string | null = null;
        for (let i = 0; i < P3_RETRIES; i++) {
            token3 = await lock.acquire(lockKey);
            if (token3) break;
            count(METRIC_LABEL_LTM_P3_RETRY);
            await new Promise((r) => setTimeout(r, P3_RETRY_DELAY_MS));
        }
        if (!token3) {
            return { status: 'COMPLETED', terminalWritten: false };
        }
        try {
            if (await terminal.isExtracted(sessionId)) {
                await processing.clear(sessionId);
                return { status: 'SKIPPED', reason: SKIP_REASON.TERMINAL };
            }
            if (layer !== 'threshold') {
                await terminal.markExtracted(sessionId);
            }
            await processing.clear(sessionId);
            return {
                status: 'COMPLETED',
                terminalWritten: layer !== 'threshold',
            };
        } finally {
            await lock.release(lockKey, token3);
        }
    }
}

export default MemoryTriggerCoordinator;

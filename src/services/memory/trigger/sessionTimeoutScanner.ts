import { runGuardedTask } from '@/lib/backgroundTask';
import { createLogger } from '@/lib/logger';
import { memoryTriggerConfig } from './memoryTriggerConfig';
import type { SessionIdentityResolver } from '@/services/memory/sessionIdentity.resolver';

const log = createLogger('ltm');

const DEFAULT_TIMEOUT_SEC = memoryTriggerConfig.l2TimeoutSec;
const DEFAULT_SCAN_INTERVAL_SEC = memoryTriggerConfig.l2ScanIntervalSec;

export type TriggerResult =
    | { status: 'COMPLETED'; terminalWritten: boolean }
    | { status: 'SKIPPED'; reason: 'LOCK' | 'TERMINAL' | 'PROCESSING' };

export interface TerminalTriggerCoordinator {
    executeTerminalTrigger(
        sessionId: string,
        layer: 'explicit' | 'timeout',
        userId?: string,
    ): Promise<TriggerResult>;
}

export interface InactiveSessionStore {
    findInactiveSessions(timeoutSec: number): Promise<string[]>;
}

export interface ScannerDeps {
    coordinator: TerminalTriggerCoordinator;
    sessionStore: InactiveSessionStore;
    resolver: SessionIdentityResolver;
    timeoutSec?: number;
    scanIntervalSec?: number;
}

export class SessionTimeoutScanner {
    private readonly coordinator: TerminalTriggerCoordinator;
    private readonly sessionStore: InactiveSessionStore;
    private readonly resolver: SessionIdentityResolver;
    private readonly timeoutSec: number;
    private readonly scanIntervalSec: number;
    private timer: NodeJS.Timeout | null = null;

    constructor(deps: ScannerDeps) {
        this.coordinator = deps.coordinator;
        this.sessionStore = deps.sessionStore;
        this.resolver = deps.resolver;
        this.timeoutSec = deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
        this.scanIntervalSec =
            deps.scanIntervalSec ?? DEFAULT_SCAN_INTERVAL_SEC;
    }

    async scanOnce(): Promise<void> {
        // 重试与失败兜底统一由 runGuardedTask 承担；整轮失败不抛出，
        // 由 start() 的周期 setInterval 自然进入下一轮
        await runGuardedTask('l2-timeout-scan', async () => {
            const sids = await this.sessionStore.findInactiveSessions(
                this.timeoutSec,
            );
            const userMap = this.resolver.resolveBatch
                ? await this.resolver.resolveBatch(sids)
                : null;
            for (const sid of sids) {
                try {
                    await this.coordinator.executeTerminalTrigger(
                        sid,
                        'timeout',
                        userMap?.get(sid) ?? undefined,
                    );
                } catch (e) {
                    log.error('L2 超时扫描单会话兜底失败', e as Error, {
                        sessionId: sid,
                    });
                }
            }
            log.info('L2 超时扫描完成', { sids });
        });
    }

    start(): void {
        if (this.timer) this.stop();
        this.timer = setInterval(() => {
            this.scanOnce().catch((e) => {
                log.error('L2 超时周期扫描异常', e as Error);
            });
        }, this.scanIntervalSec * 1000);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

export default SessionTimeoutScanner;

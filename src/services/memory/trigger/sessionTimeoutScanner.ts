import { createLogger } from '@/lib/logger';
import { memoryTriggerConfig } from './memoryTriggerConfig';

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
    ): Promise<TriggerResult>;
}

export interface InactiveSessionStore {
    findInactiveSessions(timeoutSec: number): Promise<string[]>;
}

export interface ScannerDeps {
    coordinator: TerminalTriggerCoordinator;
    sessionStore: InactiveSessionStore;
    timeoutSec?: number;
    scanIntervalSec?: number;
}

export class SessionTimeoutScanner {
    private readonly coordinator: TerminalTriggerCoordinator;
    private readonly sessionStore: InactiveSessionStore;
    private readonly timeoutSec: number;
    private readonly scanIntervalSec: number;
    private timer: NodeJS.Timeout | null = null;

    constructor(deps: ScannerDeps) {
        this.coordinator = deps.coordinator;
        this.sessionStore = deps.sessionStore;
        this.timeoutSec = deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
        this.scanIntervalSec =
            deps.scanIntervalSec ?? DEFAULT_SCAN_INTERVAL_SEC;
    }

    async scanOnce(): Promise<void> {
        const sids = await this.sessionStore.findInactiveSessions(
            this.timeoutSec,
        );
        for (const sid of sids) {
            try {
                await this.coordinator.executeTerminalTrigger(sid, 'timeout');
            } catch (e) {
                log.error('L2 超时扫描单会话兜底失败', e as Error, {
                    sessionId: sid,
                });
            }
        }
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

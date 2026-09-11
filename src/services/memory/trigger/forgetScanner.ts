// src/services/memory/trigger/forgetScanner.ts
/**
 * 每日遗忘扫描定时器（03:00 自动软删过期记忆）。
 *
 * 与 SessionTimeoutScanner 一致：本文件保持纯粹——不 import 任何外部服务，
 * 扫描实现与调度器全部由组合根（src/services/memory/index.ts）注入，
 * 避免 trigger/ 反向依赖外层模块。
 */
import { createLogger } from '@/lib/logger';
import type { ForgetScanReport } from '@/services/memory/forget.service';

const log = createLogger('ltm');

/** 默认定点：每天 03:00（本地时区） */
export const FORGET_SCAN_HOUR = 3;
export const FORGET_SCAN_MINUTE = 0;

/** 调度句柄（与 forget.service 的 DailySchedule 结构兼容） */
export interface ScheduleHandle {
    stop(): void;
}

/** 每日定点调度器签名，实际实现为 forget.service 的 scheduleDailyAt */
export type DailyScheduler = (
    hour: number,
    minute: number,
    cb: () => Promise<void> | void,
) => ScheduleHandle;

export interface ForgetScannerDeps {
    /** 扫描实现，由组合根注入 runForgetScan 的绑定 */
    scan: () => Promise<ForgetScanReport>;
    /** 定点调度实现，由组合根注入 scheduleDailyAt */
    schedule: DailyScheduler;
    hour?: number;
    minute?: number;
}

export class ForgetScanner {
    private readonly scan: () => Promise<ForgetScanReport>;
    private readonly schedule: DailyScheduler;
    private readonly hour: number;
    private readonly minute: number;
    private handle: ScheduleHandle | null = null;

    constructor(deps: ForgetScannerDeps) {
        this.scan = deps.scan;
        this.schedule = deps.schedule;
        this.hour = deps.hour ?? FORGET_SCAN_HOUR;
        this.minute = deps.minute ?? FORGET_SCAN_MINUTE;
    }

    /** 手动触发一轮扫描（真删，非 dry-run） */
    async scanOnce(): Promise<ForgetScanReport> {
        return this.scan();
    }

    start(): void {
        if (this.handle) this.stop();

        // 首次等下一个 03:00，不在启动时立即扫描——避免重启风暴
        log.info('遗忘扫描定时器已启动', {
            hour: this.hour,
            minute: this.minute,
        });

        this.handle = this.schedule(this.hour, this.minute, async () => {
            const report = await this.scanOnce();
            log.info('遗忘扫描定时任务完成', {
                totalCandidates: report.totalCandidates,
                totalDeleted: report.totalDeleted,
                truncated: report.truncated,
                backfilled: report.backfilled,
            });
        });
    }

    stop(): void {
        this.handle?.stop();
        this.handle = null;
    }
}

export default ForgetScanner;

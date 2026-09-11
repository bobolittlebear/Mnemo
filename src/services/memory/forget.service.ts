// src/services/memory/forget.service.ts
/**
 * 记忆遗忘：存量初始化（backfill）+ 分类扫描 + 定点调度工具。
 *
 * 判定依据是设计文档 §4 的四条件 AND：只有「既陈旧又不可信」的记忆才进删除面，
 * 且 type 恒为 'fact'（note_chunk / media 由各自子系统管理，不在遗忘范围）。
 *
 * 调用方：
 * - 服务内定时器 → trigger/forgetScanner.ts（每天 03:00 自动软删）
 * - 手动兜底入口 → scripts/forget-memories.ts
 */
import { MemoryFact } from '@/models/MemoryFact';
import { createLogger } from '@/lib/logger';
import {
    FORGET_CONFIDENCE_FLOOR,
    FORGET_INACTIVE_DAYS,
    FORGET_MAX_DELETES_PER_RUN,
    FORGET_NEVER_DELETE,
} from '@/utils/config';

const log = createLogger('ltm');

const DAY_MS = 86_400_000;

// ── 对外类型 ──────────────────────────────────────────────────

export interface DeletableCategory {
    category: string;
    inactiveDays: number;
}

export interface ForgetCategoryReport {
    category: string;
    inactiveDays: number;
    /** 命中四条件的全量候选数（不受单次删除上限影响，用于暴露积压规模） */
    candidates: number;
    /** 本次实际软删数 */
    deleted: number;
}

export interface ForgetScanReport {
    dryRun: boolean;
    /** 存量初始化被赋值的记录数 */
    backfilled: number;
    categories: ForgetCategoryReport[];
    totalCandidates: number;
    totalDeleted: number;
    /** 候选总数超过单次上限，本次（或执行时）会被截断 */
    truncated: boolean;
}

/** 每日定点调度句柄 */
export interface DailySchedule {
    stop(): void;
}

// ── 判定条件 ──────────────────────────────────────────────────

/**
 * 构建单个 category 的四条件 AND 过滤条件。
 *
 * 未知 category 直接抛错（fail closed）：绝不退回默认阈值 —— 用 0 天兜底会把
 * 「无对应阈值的类别」变成删除面最大的类别，与保守原则相反。
 */
export function buildForgetFilter(
    category: string,
    nowMs: number,
): Record<string, unknown> {
    const inactiveDays = FORGET_INACTIVE_DAYS[category];
    if (inactiveDays === undefined) {
        throw new Error(`未知的记忆类别，拒绝构建遗忘过滤器: ${category}`);
    }

    return {
        type: 'fact',
        category,
        deletedAt: { $exists: false },
        // $exists 保底与 $lt 范围必须合并进同一个子文档：拆成两个 lastSignificantAt
        // 键会互相覆盖，丢掉 $exists —— 没有该字段的存量记忆就会进入候选（N1 误删窗口）
        lastSignificantAt: {
            $exists: true,
            $lt: new Date(nowMs - inactiveDays * DAY_MS),
        },
        confidence: { $lt: FORGET_CONFIDENCE_FLOOR },
    };
}

/**
 * 可删类别：排除 NEVER_DELETE（instruction / preference），按阈值升序。
 *
 * 升序让「先到先得」的单次上限预算优先喂给最易过时的类别（event/other/diet 等）；
 * 同阈值时保持声明顺序（Array.sort 稳定）。
 */
export function deletableCategories(): DeletableCategory[] {
    const neverDelete = FORGET_NEVER_DELETE as readonly string[];

    return Object.entries(FORGET_INACTIVE_DAYS)
        .filter(([category]) => !neverDelete.includes(category))
        .sort(([, a], [, b]) => a - b)
        .map(([category, inactiveDays]) => ({ category, inactiveDays }));
}

// ── 存量初始化 ────────────────────────────────────────────────

/**
 * 幂等 backfill：给 `lastSignificantAt` 为空的 fact 记录赋值为其 `createdAt`。
 *
 * 目的是防冷启动清空——存量记忆若一直缺字段，日龄无从计算；但也不能简单设成
 * 「现在」，否则它们会从今天重新变老。用聚合管道引用 `$createdAt` 字段值，
 * 让它们从真实创建日龄化。
 *
 * 可重复执行：filter 只命中仍缺字段的记录。
 */
export async function backfillLastSignificantAt(): Promise<number> {
    const res = await MemoryFact.updateMany(
        { type: 'fact', lastSignificantAt: { $exists: false } },
        [{ $set: { lastSignificantAt: '$createdAt' } }],
    );

    const modified = res.modifiedCount ?? 0;
    if (modified > 0) {
        log.info('遗忘 backfill 完成', { modified });
    }
    return modified;
}

// ── 扫描 ──────────────────────────────────────────────────────

/**
 * 执行一轮遗忘扫描。
 *
 * 流程：backfill → 按阈值升序逐类四条件判定 → 软删（受全局上限约束）。
 * `dryRun`（默认）只统计不写库，用于人工复核。
 *
 * 上限是全局的、不是 per-category 的：预算先到先得，耗尽即停后续类别。
 */
export async function runForgetScan(
    opts: { dryRun?: boolean } = {},
): Promise<ForgetScanReport> {
    const dryRun = opts.dryRun ?? true; // 默认 dry-run，安全侧
    const startTime = Date.now();
    const nowMs = startTime;

    const backfilled = await backfillLastSignificantAt();

    const categories: ForgetCategoryReport[] = [];
    let remaining = FORGET_MAX_DELETES_PER_RUN;
    let totalCandidates = 0;
    let totalDeleted = 0;

    for (const { category, inactiveDays } of deletableCategories()) {
        const filter = buildForgetFilter(category, nowMs);

        // 候选数取全量（不带 limit），让报告暴露真实积压规模；
        // 实际删除才受 remaining 约束
        const candidates = await MemoryFact.countDocuments(filter);
        if (candidates === 0) continue;

        let deleted = 0;
        if (!dryRun && remaining > 0) {
            const take = Math.min(remaining, candidates);
            // updateMany 不支持 limit，故先按上限取 _id 再定向更新
            const docs = await MemoryFact.find(filter)
                .select('_id')
                .limit(take)
                .lean();

            if (docs.length > 0) {
                const res = await MemoryFact.updateMany(
                    { _id: { $in: docs.map((d) => d._id) } },
                    { $set: { deletedAt: new Date() } },
                );
                deleted = res.modifiedCount ?? 0;
                remaining -= deleted;
            }
        }

        totalCandidates += candidates;
        totalDeleted += deleted;
        categories.push({
            category,
            inactiveDays,
            candidates,
            deleted,
        });

        log.info('遗忘扫描分类完成', {
            component: 'mongodb',
            category,
            inactiveDays,
            candidates,
            deleted,
            dryRun,
            remaining,
        });
    }

    const truncated = totalCandidates > FORGET_MAX_DELETES_PER_RUN;

    log.info(dryRun ? '遗忘扫描完成（dry-run）' : '遗忘扫描完成（已软删）', {
        component: 'mongodb',
        dryRun,
        backfilled,
        totalCandidates,
        totalDeleted,
        truncated,
        duration_ms: Date.now() - startTime,
        categories: categories.map((c) => `${c.category}:${c.deleted}/${c.candidates}`),
    });

    if (truncated) {
        log.warn('遗忘候选超过单次上限，本次执行将被截断', {
            totalCandidates,
            maxDeletes: FORGET_MAX_DELETES_PER_RUN,
        });
    }

    return {
        dryRun,
        backfilled,
        categories,
        totalCandidates,
        totalDeleted,
        truncated,
    };
}

// ── 定点调度 ──────────────────────────────────────────────────

/**
 * 距下一个 hour:minute 的毫秒数（本地时区）。
 *
 * 恰好落在目标时刻时返回「明天」的间隔，避免同一时刻重复触发。
 */
export function msUntilNextDaily(
    hour: number,
    minute: number,
    nowMs: number,
): number {
    const next = new Date(nowMs);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= nowMs) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - nowMs;
}

/**
 * 每天 hour:minute 执行一次 cb。
 *
 * 用递归 setTimeout 而非 setInterval：上一轮跑完才排下一轮，天然避免重叠，
 * 也不会因执行耗时累积漂移。
 *
 * 返回句柄的 `stop()` 会终止整条递归链——只清当前 timer 是不够的，
 * 因为下一次调度是在回调内部重新创建的。
 */
export function scheduleDailyAt(
    hour: number,
    minute: number,
    cb: () => Promise<void> | void,
): DailySchedule {
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;

    const scheduleNext = (): void => {
        if (stopped) return;

        timer = setTimeout(async () => {
            try {
                await cb();
            } catch (error) {
                // 单次失败不得中断每日链条（DB / 网络瞬时故障）
                log.error('遗忘定时任务执行失败', error as Error);
            }
            scheduleNext();
        }, msUntilNextDaily(hour, minute, Date.now()));
    };

    scheduleNext();

    return {
        stop(): void {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

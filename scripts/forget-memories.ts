// scripts/forget-memories.ts
// 手动兜底入口（服务内定时器已每天 03:00 自动执行，本脚本用于运维复核与存量初始化）。
//
// 用法（项目根目录）：
//   pnpm forget:memories                    # 默认 dry-run，只统计不写库
//   pnpm forget:memories --dry-run          # 同上，显式声明
//   pnpm forget:memories --execute          # 真删（受全局 50 上限约束）
//   pnpm forget:memories --backfill-only    # 仅存量初始化，不扫描不删
//
// 注：tsconfig-paths/register 必须在 import @/ 模块之前注册——独立 ts-node 进程
// 只按源码里的相对路径解析，@/ 别名要靠它转换。
import 'tsconfig-paths/register';
import dotenv from 'dotenv';
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});

import mongoose from 'mongoose';
import {
    runForgetScan,
    backfillLastSignificantAt,
} from '../src/services/memory/forget.service';
import type { ForgetScanReport } from '../src/services/memory/forget.service';

const MONGO_URI =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';

function printReport(report: ForgetScanReport): void {
    console.log(`\n=== 遗忘扫描报告 (${report.dryRun ? 'dry-run' : '已执行'}) ===`);
    console.log(`backfill 赋值: ${report.backfilled} 条`);

    if (report.categories.length === 0) {
        console.log('无命中四条件的候选记忆');
    } else {
        console.log('\ncategory           阈值(天)   候选   已删');
        for (const c of report.categories) {
            console.log(
                `${c.category.padEnd(18)}${String(c.inactiveDays).padEnd(10)}` +
                    `${String(c.candidates).padEnd(7)}${c.deleted}`,
            );
        }
        console.log(
            `\n合计: 候选 ${report.totalCandidates} 条, 已删 ${report.totalDeleted} 条`,
        );
    }

    if (report.truncated) {
        console.log(
            '⚠️  候选数超过单次上限 50，本次执行将被截断（先到先得，按阈值升序）',
        );
    }
    if (report.dryRun && report.totalCandidates > 0) {
        console.log('这是 dry-run，未写库。确认无误后加 --execute 执行软删。');
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const backfillOnly = args.includes('--backfill-only');
    const execute = args.includes('--execute');

    await mongoose.connect(MONGO_URI, { autoIndex: false });

    if (backfillOnly) {
        // 仅存量初始化：不扫描、不软删，可重复执行
        const modified = await backfillLastSignificantAt();
        console.log(
            `\n=== backfill-only 完成 ===\nlastSignificantAt 赋值: ${modified} 条`,
        );
        return;
    }

    // 默认 dry-run，仅显式 --execute 才写库
    const report = await runForgetScan({ dryRun: !execute });
    printReport(report);
}

main()
    .catch((error) => {
        console.error('[forget] 执行失败:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });

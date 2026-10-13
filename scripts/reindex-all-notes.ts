/// <reference types="node" />
// scripts/reindex-all-notes.ts
// 强制全量重建笔记 RAG 索引（NoteChunk.searchText + embedding）。
//
// 用途：jieba 领域词典 / 分词器变更后，存量 searchText 仍是旧词典切分，必须重切才能生效。
// 增量 diff 会因 contentHash 未变而 no-op，故走 incrementalReindex({ force: true }) 绕过比对。
//
// 用法（项目根目录）：
//   pnpm reindex:all                              # 全量（所有用户，仅本地 dev，注意会全量重 embed）
//   REINDEX_USER_ID=<userId> pnpm reindex:all     # 仅指定用户
// 可选环境变量：REINDEX_CONCURRENCY（默认 5，保护 Atlas embedding 配额）。
import dotenv from 'dotenv';

dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
    quiet: true,
});

import mongoose from 'mongoose';
import { NoteChunk } from '../src/models/NoteChunk'; // 引入即触发 Schema 注册
import { forceReindexAll } from '../src/services/notebook/noteReindex.service';
// forceReindexAll 所在模块会连带引入 redisClient（模块加载即 connect），
// 不关掉它脚本的 event loop 不会退出——本脚本不使用 Redis，收尾时主动断开。
import redisClient from '../src/lib/redis';

async function main(): Promise<void> {
    const userId = process.env.REINDEX_USER_ID || undefined;
    const rawConcurrency = Number(process.env.REINDEX_CONCURRENCY ?? 5);
    const concurrency =
        Number.isInteger(rawConcurrency) && rawConcurrency > 0
            ? rawConcurrency
            : 5;
    if (concurrency !== rawConcurrency) {
        console.warn(
            `REINDEX_CONCURRENCY 非法（${process.env.REINDEX_CONCURRENCY}），回退默认 5`,
        );
    }

    const MONGO_URI =
        process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';
    await mongoose.connect(MONGO_URI, { autoIndex: false });
    console.log('已连接 MongoDB，开始强制全量 reindex…');
    if (!userId) {
        console.warn(
            '⚠️ 未指定 REINDEX_USER_ID，将对全量 NoteChunk 所属笔记重建（仅本地 dev 用）',
        );
    }

    try {
        const result = await forceReindexAll({ userId, concurrency });
        console.log(
            `完成：total=${result.total} succeeded=${result.succeeded} ` +
                `failed=${result.failed} 用时 ${result.durationMs}ms`,
        );
    } finally {
        await mongoose.disconnect();
        // redisClient 在模块加载时即 connect，需显式 quit 才能让进程退出
        if (redisClient.isOpen) await redisClient.quit();
    }
}

main().catch((error) => {
    console.error('强制全量 reindex 失败', error);
    process.exitCode = 1;
});

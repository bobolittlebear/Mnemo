/// <reference types="node" />
// scripts/dump-note-chunks.ts
// 把 MongoDB 的 NoteChunk 集合导出为仓库内 JSON 文件，供离线标注 / 生成评测数据集使用。
//
// 用法（项目根目录）：
//   pnpm dump:note-chunks --userId <NoteChunk.userId>
//   或：EVAL_USER_ID=<id> pnpm dump:note-chunks
//   不带 --userId / EVAL_USER_ID 则导出全量（仅本地 dev，注意含所有用户笔记正文，勿提交）。
//
// 输出：tests/evals/datasets/note-chunks-dump.json（含正文，已加 .gitignore）
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
    quiet: true,
});

import mongoose from 'mongoose';
import { NoteChunk } from '../src/models/NoteChunk';

const DATASET_DIR = path.join(process.cwd(), 'tests/evals/datasets');
const OUT_PATH = path.join(DATASET_DIR, 'note-chunks-dump.json');

function toStr(v: unknown): string | null {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof (v as { toString?: () => string }).toString === 'function') {
        return (v as { toString: () => string }).toString();
    }
    return null;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const i = args.indexOf('--userId');
    const userId = (i >= 0 ? args[i + 1] : undefined) || process.env.EVAL_USER_ID;

    const MONGO_URI =
        process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';
    await mongoose.connect(MONGO_URI, { autoIndex: false });

    try {
        const filter = userId ? { userId } : {};
        if (!userId) {
            console.warn(
                '⚠️ 未指定 --userId / EVAL_USER_ID，将导出全量 NoteChunk（含所有用户笔记正文，仅本地 dev 用，勿提交）',
            );
        }

        const docs = await NoteChunk.find(filter)
            .select(
                '_id userId notebookId noteId title chunkType parentId sectionPath chunkIndex content searchText contentHash updatedAt',
            )
            .lean();

        const chunks = (docs as Array<Record<string, unknown>>).map((d) => ({
            _id: toStr(d._id)!,
            userId: toStr(d.userId)!,
            notebookId: toStr(d.notebookId),
            noteId: toStr(d.noteId),
            title: (d.title as string) ?? '',
            chunkType: (d.chunkType as string) ?? '',
            parentId: toStr(d.parentId),
            sectionPath: (d.sectionPath as string[]) ?? [],
            chunkIndex: (d.chunkIndex as number) ?? 0,
            content: (d.content as string) ?? '',
            searchText: (d.searchText as string) ?? '',
            contentHash: (d.contentHash as string) ?? '',
            updatedAt: d.updatedAt ? (d.updatedAt as Date).toISOString() : null,
        }));

        const out = {
            dumpedAt: new Date().toISOString(),
            userId: userId ?? null,
            note: '本文件含笔记正文与真实 _id，为评测标注中间产物，勿提交（已加 .gitignore）。',
            count: chunks.length,
            chunks,
        };

        fs.mkdirSync(DATASET_DIR, { recursive: true });
        fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf-8');

        const child = chunks.filter((c) => c.chunkType === 'child').length;
        const parent = chunks.length - child;
        console.log(`✅ 已导出 ${chunks.length} 条 NoteChunk → ${OUT_PATH}`);
        console.log(`   child=${child}  parent=${parent}`);
        if (userId) console.log(`   userId 过滤：${userId}`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error('dump 失败', error);
    process.exitCode = 1;
});

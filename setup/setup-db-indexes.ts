// setup/setup-db-indexes.ts
// 在项目根目录执行：pnpm setup:indexes
// 显式创建/对账 MemoryFact 与 NoteChunk 的 schema 声明索引（普通索引 + text index）。
// 背景：生产 NODE_ENV=production + mongoose autoIndex:false 时不会自动建索引，
// 部署后需运行本脚本显式创建/对账，否则 BM25 路 $text 检索会报错。
/// <reference types="node" />
import mongoose from 'mongoose';
import { MemoryFact } from '../src/models/MemoryFact';
import { NoteChunk } from '../src/models/NoteChunk';
import dotenv from 'dotenv';
// 加载 .env 中的 AI_API_KEY / MONGODB_URI / EMBEDDING_DIMENSIONS
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});

const MONGO_URI =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';

async function printIndexes(label: string, collectionName: string) {
    const indexes = await mongoose.connection.db
        ?.collection(collectionName)
        ?.indexes();
    console.log(`=== ${label} Indexes (${collectionName}) ===`);
    indexes?.forEach?.((idx) => {
        console.log(`Name: ${idx.name}`);
        console.log(`  Keys: ${JSON.stringify(idx.key)}`);
        console.log(`  Unique: ${!!idx.unique}`);
        console.log(`  Sparse: ${!!idx.sparse}`);
        console.log('---');
    });
}

async function setupIndexes() {
    // 显式关 autoIndex，索引由下方 syncIndexes 显式管理，不依赖连接期隐式建
    await mongoose.connect(MONGO_URI, { autoIndex: false });

    // syncIndexes 幂等：创建 schema 声明的索引，drop 已不存在的旧索引（可清理残留 text index）
    const [memoryFactDropped, noteChunkDropped] = await Promise.all([
        MemoryFact.syncIndexes(),
        NoteChunk.syncIndexes(),
    ]);
    if (memoryFactDropped.length > 0) {
        console.log(
            `[setup] MemoryFact 清理残留索引: ${memoryFactDropped.join(', ')}`,
        );
    }
    if (noteChunkDropped.length > 0) {
        console.log(
            `[setup] NoteChunk 清理残留索引: ${noteChunkDropped.join(', ')}`,
        );
    }

    // 打印最终索引清单，便于审计
    await printIndexes('MemoryFact', 'memoryfacts');
    await printIndexes('NoteChunk', 'notechunks');
}

async function main() {
    try {
        await setupIndexes();
        console.log('[setup] 索引对账完成');
    } catch (error) {
        console.error('[setup] 索引对账失败:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }
}

main();

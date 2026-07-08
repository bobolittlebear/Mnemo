// npx ts-node scripts/test-vector-search.ts
import mongoose from 'mongoose';
import { MemoryFact } from '../src/models/MemoryFact';

async function testVectorSearch() {
    try {
        // 1. 连接数据库（替换为你的真实连接字符串）
        const connStr =
            process.env.MONGODB_URI || 'mongodb://localhost:27017/test';

        await mongoose.connect(connStr);
        console.log('✅ MongoDB Connected');

        // 2. 执行 $vectorSearch 聚合
        // 💡 注意：Mongoose 的 aggregate() 返回的是 Aggregate 对象，需调用 .exec() 或 await
        const results = await MemoryFact.aggregate([
            {
                $vectorSearch: {
                    index: 'autoembed_index',
                    path: 'embedding',
                    queryVector: new Array(1536).fill(0.01), // 1536维测试向量
                    numCandidates: 10,
                    limit: 3,
                    filter: {
                        memoryKey: { $eq: 'test-user' },
                        type: { $eq: 'fact' },
                    },
                },
            },
            {
                $addFields: {
                    score: { $meta: 'vectorSearchScore' },
                },
            },
        ]).exec();

        // 3. 输出结果
        if (results.length > 0) {
            console.log(`🎉 找到 ${results.length} 条匹配记忆:`);
            results.forEach((r, i) => {
                console.log(
                    `  [${i + 1}] score=${r.score.toFixed(4)} | content="${r.content}"`,
                );
            });
        } else {
            console.log('❌ 未找到匹配文档，请检查：');
            console.log('   1. 索引是否 READY');
            console.log('   2. filter 条件是否与测试数据匹配');
            console.log('   3. embedding 维度是否为 1536');
        }
    } catch (error) {
        console.error('💥 Vector Search 失败:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected');
    }
}

testVectorSearch();

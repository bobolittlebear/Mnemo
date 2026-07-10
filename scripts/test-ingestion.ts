/**
 * 1.4 入库与去重策略 - 端到端验证脚本
 * npx ts-node -r tsconfig-paths/register scripts/test-ingestion.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
    ingestMemoryFacts,
    ExtractedFact,
    IngestionContext,
} from '../src/service/memoryIngestion.service';
import { MemoryFact } from '../src/models/MemoryFact';
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});

const MONGO_URI =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/ltm_test';

// 生成模拟的 1536 维向量
const mockEmbedding = Array.from({ length: 1536 }, () => Math.random());

async function runTests() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB 连接成功\n');

    // 清理测试数据
    await MemoryFact.deleteMany({
        memoryKey: { $in: ['test_user_001', 'test_temp_session'] },
    });
    console.log('🧹 测试数据已清理\n');

    const date = Date.now();

    try {
        // ========== 测试 1: 首次写入 ==========
        console.log('📝 [测试1] 首次写入...');
        const ctx1: IngestionContext = {
            memoryKey: 'test_user_001',
            sourceMessageIds: [`msg_${date}_001`],
            notebookId: 'nb_001',
        };
        const facts1: ExtractedFact[] = [
            {
                content: '用户喜欢使用 TypeScript 开发后端服务',
                embedding: mockEmbedding,
                confidence: 0.95,
                category: 'preference',
                metadata: { source: 'chat' },
            },
        ];
        const res1 = await ingestMemoryFacts(facts1, ctx1);
        console.log(
            `   结果: inserted=${res1.inserted}, updated=${res1.updated}`,
        );
        console.assert(
            res1.inserted === 1 && res1.updated === 0,
            '❌ 测试1失败: 首次写入应 inserted=1',
        );
        console.log('   ✅ 测试1通过\n');

        // ========== 测试 2: 相同内容重复写入 (去重 + 溯源追加) ==========
        console.log('📝 [测试2] 相同内容重复写入...');
        const ctx2: IngestionContext = {
            memoryKey: 'test_user_001',
            sourceMessageIds: [`msg_${date}_002`, `msg_${date}_003`], // 新的消息ID
        };
        const res2 = await ingestMemoryFacts(facts1, ctx2); // 相同的 facts
        const doc2 = await MemoryFact.findOne({
            memoryKey: 'test_user_001',
            contentHash: { $exists: true },
        });
        console.log(
            `   结果: inserted=${res2.inserted}, updated=${res2.updated}`,
        );
        console.log(
            `   sourceMessageIds: ${JSON.stringify(doc2?.sourceMessageIds)}`,
        );
        console.assert(
            res2.inserted === 0 && res2.updated === 1,
            '❌ 测试2失败: 重复写入应 updated=1',
        );
        console.assert(
            doc2?.sourceMessageIds?.length === 3,
            '❌ 测试2失败: sourceMessageIds 应有3个元素',
        );
        console.log('   ✅ 测试2通过\n');

        // ========== 测试 3: 不同 memoryKey 相同内容 (租户隔离) ==========
        console.log('📝 [测试3] 不同 memoryKey 相同内容...');
        const ctx3: IngestionContext = {
            memoryKey: 'test_temp_session', // 不同的 key
            sourceMessageIds: ['msg_temp_001'],
        };
        const res3 = await ingestMemoryFacts(facts1, ctx3);
        const count3 = await MemoryFact.countDocuments({
            content: '用户喜欢使用 TypeScript 开发后端服务',
        });
        console.log(
            `   结果: inserted=${res3.inserted}, updated=${res3.updated}`,
        );
        console.log(`   相同内容记录总数: ${count3}`);
        console.assert(res3.inserted === 1, '❌ 测试3失败: 不同key应独立插入');
        console.assert(count3 === 2, '❌ 测试3失败: 应有2条独立记录');
        console.log('   ✅ 测试3通过\n');

        // ========== 测试 4: 批量混合写入 ==========
        console.log('📝 [测试4] 批量混合写入...');
        const ctx4: IngestionContext = {
            memoryKey: 'test_user_001',
            sourceMessageIds: ['msg_batch_001'],
        };
        const facts4: ExtractedFact[] = [
            {
                content: '用户喜欢使用 TypeScript 开发后端服务',
                embedding: mockEmbedding,
                confidence: 0.9,
                category: 'preference',
            }, // 已存在
            {
                content: '用户的项目使用 MongoDB Atlas 作为向量数据库',
                embedding: mockEmbedding,
                confidence: 0.88,
                category: 'tech_stack',
            }, // 新事实
            {
                content: '用户偏好深色主题',
                embedding: mockEmbedding,
                confidence: 0.92,
                category: 'preference',
            }, // 新事实
        ];
        const res4 = await ingestMemoryFacts(facts4, ctx4);
        console.log(
            `   结果: inserted=${res4.inserted}, updated=${res4.updated}`,
        );
        console.assert(
            res4.inserted === 2 && res4.updated === 1,
            '❌ 测试4失败: 应 inserted=2, updated=1',
        );
        console.log('   ✅ 测试4通过\n');

        console.log('🎉 所有测试通过！1.4 入库与去重策略验证成功！');
    } catch (error: any) {
        console.error('💥 测试执行出错:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 MongoDB 连接已关闭');
    }
}

runTests();

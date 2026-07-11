/**
 * P0-2.2 Embedding 批量管道验收测试
 * 运行: npx ts-node -r tsconfig-paths/register scripts/test-embedding.ts
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { generateEmbeddings } from '../src/lib/embedding'; // ⭐️ 根据实际路径调整
// 加载 .env 中的 AI_API_KEY / MONGODB_URI / EMBEDDING_DIMENSIONS
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});

const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1536;

async function runTests() {
    let passed = 0;
    let failed = 0;

    const assert = (condition: boolean, message: string) => {
        if (condition) {
            console.log(`  ✅ ${message}`);
            passed++;
        } else {
            console.error(`  ❌ ${message}`);
            failed++;
        }
    };

    try {
        // 连接 DB（部分 embedding 服务可能依赖 DB 配置，保持与生产一致）
        const connStr =
            process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
        await mongoose.connect(connStr);
        console.log('🔗 MongoDB Connected\n');

        // ========== Test 1: 基本功能 ==========
        console.log('📝 Test 1: 基本批量生成');
        const { embeddings: vecs } = await generateEmbeddings([
            'hello world',
            '向量搜索测试',
            'third text',
        ]);
        assert(vecs.length === 3, `返回数量正确 (${vecs.length}/3)`);
        assert(
            vecs?.[0]?.length === EMBEDDING_DIMENSIONS,
            `维度正确 (${vecs?.[0]?.length}/${EMBEDDING_DIMENSIONS})`,
        );
        assert(
            Array.isArray(vecs?.[0]) && typeof vecs?.[0]?.[0] === 'number',
            '返回值为 number[][] 类型',
        );

        // ========== Test 2: 空输入安全 ==========
        console.log('\n📝 Test 2: 空输入安全');
        const { embeddings: empty } = await generateEmbeddings(['', '  ', '']);
        assert(empty.length === 0, `全空输入返回空数组 (${empty.length}/0)`);

        const { embeddings: mixed } = await generateEmbeddings([
            'valid',
            '',
            'also valid',
        ]);
        assert(mixed.length === 2, `混合空字符串自动过滤 (${mixed.length}/2)`);

        // ========== Test 3: 大批量自动分批 ==========
        console.log('\n📝 Test 3: 大批量自动分批 (250条)');
        const startTime = Date.now();
        const { embeddings: many } = await generateEmbeddings(
            Array.from(
                { length: 250 },
                (_, i) =>
                    `This is test sentence number ${i} for batch embedding validation.`,
            ),
        );
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        assert(many.length === 250, `250条全部返回 (${many.length}/250)`);
        console.log(`  ⏱️ 耗时: ${elapsed}s`);

        // // ========== Test 4: 顺序一致性 ==========
        // console.log('\n📝 Test 5: 输入输出顺序一致性');
        // const ordered = await generateEmbeddings({input: ['alpha', 'beta', 'gamma']});
        // // 验证方式：相同输入应产生相同向量
        // const alphaAgain = await generateEmbedding({input: 'alpha'});
        // const diff = Math.abs(ordered[0][0] - alphaAgain[0]);
        // assert(diff < 1e-6, `相同输入向量一致 (diff=${diff.toExponential(2)})`);
    } catch (error: any) {
        console.error('\n💥 测试执行异常:', error);
        failed++;
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 MongoDB Disconnected');
    }

    // ========== 汇总 ==========
    console.log(`\n${'='.repeat(40)}`);
    console.log(`📊 测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}`);

    if (failed > 0) {
        process.exit(1); // CI 中失败时返回非零退出码
    }
}

runTests();

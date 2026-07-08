/**
 * P0-2.2 Embedding 批量管道验收测试
 * 运行: npx ts-node -r tsconfig-paths/register scripts/test-extraction.ts
 */
import dotenv from 'dotenv';
import MemoryExtractionService from '../src/service/memoryExtraction.service';
import STM from '../src/util/shortTermMemory';
import { createLogger } from '../src/lib/logger';
import mongoose from 'mongoose';

dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});

const logger = createLogger('rag');

interface TestMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

async function runTests() {
    const testMemoryKey = `67f94d82271545d0321a900ef5e6daed`;
    let passed = 0;
    let failed = 0;

    const assert = (condition: boolean, msg: string) => {
        if (condition) {
            console.log(`  ✅ ${msg}`);
            passed++;
        } else {
            console.error(`  ❌ ${msg}`);
            failed++;
        }
    };

    try {
        // 连接 DB（部分 embedding 服务可能依赖 DB 配置，保持与生产一致）
        const connStr =
            process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
        await mongoose.connect(connStr);
        console.log('🔗 MongoDB Connected\n');
        // ============================================
        // 测试1：清洗 + 过滤 + 批量向量化
        // ============================================
        console.log('\n📝 测试1: 摘要清洗与批量向量化');
        const messages1: TestMessage[] = [
            {
                id: 'msg-001',
                role: 'user',
                content: '我叫张三哈哈哈哈哈！！！今天天气真好呢~',
            },
            {
                id: 'msg-002',
                role: 'assistant',
                content: '你好张三！今天确实是个好天气。',
            },
            {
                id: 'msg-003',
                role: 'user',
                content: '我在北京做后端开发，主要用 TypeScript 和 Node.js。',
            },
        ];

        const count1 = await MemoryExtractionService.extract(
            testMemoryKey,
            messages1,
        );

        assert(count1 > 0, `应提取至少1条有效事实 (实际: ${count1})`);
        // 验证 Redis 标记已更新
        const lastId1 = await STM.getLastExtractedMsgId(testMemoryKey);
        assert(
            lastId1 === 'msg-003',
            `Redis 标记应更新为最后一条消息ID (实际: ${lastId1})`,
        );

        // ============================================
        // 测试2：无价值内容应返回0且更新标记
        // ============================================
        console.log('\n📝 测试2: 无价值内容过滤');
        const testKey2 = `${testMemoryKey}:chitchat`;
        const messages2: TestMessage[] = [
            { id: 'msg-010', role: 'user', content: '嗯嗯好的哈哈哈' },
            { id: 'msg-011', role: 'assistant', content: '好的呢~' },
        ];

        const count2 = await MemoryExtractionService.extract(
            testKey2,
            messages2,
        );
        assert(count2 === 0, `闲聊内容应返回0条事实 (实际: ${count2})`);

        const lastId2 = await STM.getLastExtractedMsgId(testKey2);
        assert(
            lastId2 === 'msg-011',
            `即使无事实，Redis 标记也应更新 (实际: ${lastId2})`,
        );

        // ============================================
        // 测试3：幂等性 - 重复提取应跳过
        // ============================================
        console.log('\n📝 测试3: 幂等去重');
        // 使用测试1相同的 memoryKey 和重叠的 sourceMessageIds
        const messages3: TestMessage[] = [
            {
                id: 'msg-002',
                role: 'assistant',
                content: '你好张三！今天确实是个好天气。',
            },
            {
                id: 'msg-003',
                role: 'user',
                content: '我在北京做后端开发，主要用 TypeScript 和 Node.js。',
            },
        ];

        const count3 = await MemoryExtractionService.extract(
            testMemoryKey,
            messages3,
        );
        assert(count3 === 0, `重复消息应被幂等跳过 (实际: ${count3})`);

        // ============================================
        // 测试4：空输入安全
        // ============================================
        console.log('\n📝 测试4: 空输入安全');
        const count4 = await MemoryExtractionService.extract(
            `${testMemoryKey}:empty`,
            [],
        );
        assert(count4 === 0, `空消息数组应返回0 (实际: ${count4})`);
    } catch (error) {
        console.error('\n💥 测试执行异常:', error);
        failed++;
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 MongoDB Disconnected');
    }

    // ============================================
    // 汇总报告
    // ============================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🏁 1.3 验收结果: ${passed} passed / ${failed} failed`);
    console.log(`${'='.repeat(50)}\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    logger.error('Test script crashed', err);
    process.exit(1);
});

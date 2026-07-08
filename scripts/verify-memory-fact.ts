// npx ts-node scripts/verify-memory-fact.ts
/**
 * 验证 MemoryFact 模型
 */
import mongoose from 'mongoose';
import { MemoryFact } from '../src/models/MemoryFact';

async function verify() {
    await mongoose.connect(
        process.env.MONGODB_URI || 'mongodb://localhost:27017/test',
    );

    // 🧹 清理测试数据
    await MemoryFact.deleteMany({ memoryKey: 'test-verify' });

    // ✅ Case 1: 正常插入
    try {
        await MemoryFact.create({
            memoryKey: 'test-verify',
            content: '用户喜欢秋天',
            sourceMessageIds: ['msg-001', 'msg-002'],
            confidence: 0.9,
        });
        console.log('✅ Case 1 PASS: 正常插入成功');
    } catch (e) {
        console.log('❌ Case 1 FAIL:', (e as Error)?.message ?? '');
    }

    // ❌ Case 2: 空 sourceMessageIds 校验
    try {
        await MemoryFact.create({
            memoryKey: 'test-verify',
            content: '测试空数组',
            sourceMessageIds: [], // ← 应被拦截
            confidence: 0.8,
        });
        console.log('❌ Case 2 FAIL: 空数组未被拦截');
    } catch (e: any) {
        const isValidationError = e.name === 'ValidationError';
        console.log(
            isValidationError
                ? '✅ Case 2 PASS: 空数组校验生效'
                : `❌ Case 2 FAIL: 错误类型不对 ${e.name}`,
        );
    }

    // ❌ Case 3: 唯一索引去重（相同 sourceMessageIds）
    try {
        await MemoryFact.create({
            memoryKey: 'test-verify',
            content: '重复事实',
            sourceMessageIds: ['msg-001', 'msg-002'], // ← 与 Case1 完全相同
            confidence: 0.7,
        });
        console.log('❌ Case 3 FAIL: 重复数据未被拦截');
    } catch (e: any) {
        const isDupKey = e.code === 11000;
        console.log(
            isDupKey
                ? '✅ Case 3 PASS: 唯一索引去重生效'
                : `❌ Case 3 FAIL: 错误码不对 ${e.code}`,
        );
    }

    // ❌ Case 4: 部分重叠的 sourceMessageIds（数组元素级去重）
    try {
        await MemoryFact.create({
            memoryKey: 'test-verify',
            content: '部分重叠',
            sourceMessageIds: ['msg-002', 'msg-003'], // ← msg-002 已在 Case1 中
            confidence: 0.8,
        });
        console.log('❌ Case 4 FAIL: 部分重叠未被拦截');
    } catch (e: any) {
        const isDupKey = e.code === 11000;
        console.log(
            isDupKey
                ? '✅ Case 4 PASS: 数组元素级去重生效'
                : `❌ Case 4 FAIL: 错误码不对 ${e.code}`,
        );
    }

    // 🧹 清理
    await MemoryFact.deleteMany({ memoryKey: 'test-verify' });
    await mongoose.disconnect();
    console.log('\n🧹 测试数据已清理');
}

verify().catch(console.error);

/**
 * IngestionService 单元测试
 *
 * 测试目标：contentHash 去重 + bulkWrite upsert 入库 + 写入侧 tokenCount（M2）
 * Mock 依赖：MemoryFact.bulkWrite（MongoDB）
 * 真实逻辑：operations 构建、contentHash 计算、全量 content 落库、token 计数、结果解析
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──
vi.mock('@/models/MemoryFact', () => ({
    MemoryFact: {
        bulkWrite: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// 注意：源码中写的是 @/utils/tool（带 s），实际目录是 src/util/
// mock 路径必须与源码 import 路径一致才能生效
vi.mock('@/utils/tool', () => ({
    generateContentHash: (content: string) => `hash_${content}`,
    generateSessionKey: (sessionId: string) => `mnemo:extraction:${sessionId}`,
}));

// ── 引入被测模块 ──
import { MemoryFact } from '@/models/MemoryFact';
import { ingestMemoryFacts } from '@/services/memory/memoryIngestion.service';
import { countTokens, tokenize } from '@/utils/tokenizer';
import { BUDGET_CONFIG } from '@/utils/config';
import * as fixtures from '../../../helpers/fixtures';
import type { EmbeddedFact, IngestionContext } from '@/types/memory';

const mockedBulkWrite = vi.mocked(MemoryFact.bulkWrite);

// ── 测试数据构造 ──
function makeFacts(count: number): EmbeddedFact[] {
    return Array.from({ length: count }, (_, i) => ({
        content: `事实内容${i + 1}`,
        confidence: 0.8 + i * 0.01,
        embedding: [0.1 * (i + 1), 0.2 * (i + 1), 0.3 * (i + 1)],
        sourceMessageIds: [],
    }));
}

const ctx: IngestionContext = {
    userId: fixtures.mockUserId,
    sessionId: fixtures.mockUserId,
};

beforeEach(() => {
    mockedBulkWrite.mockReset();
});

describe('IngestionService', () => {
    it('I1 - 正常入库 3 条事实应返回 inserted:3', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        const result = await ingestMemoryFacts(makeFacts(3), ctx);
        expect(result.totalProcessed).toBe(3);
        expect(result.inserted).toBe(3);
        expect(result.updated).toBe(0);
        expect(mockedBulkWrite).toHaveBeenCalledTimes(1);
    });

    it('I2 - 空数组应跳过 bulkWrite 返回全 0', async () => {
        const result = await ingestMemoryFacts([], ctx);
        expect(result.totalProcessed).toBe(0);
        expect(result.inserted).toBe(0);
        expect(mockedBulkWrite).not.toHaveBeenCalled();
    });

    it('I2b - 单条事实应正确入库', async () => {
        mockedBulkWrite.mockResolvedValue({
            insertedCount: 0,
            modifiedCount: 0,
            upsertedCount: 1,
            deletedCount: 0,
            matchedCount: 0,
        } as any);
        const result = await ingestMemoryFacts(makeFacts(1), ctx);
        expect(result.totalProcessed).toBe(1);
        expect(result.inserted).toBe(1);
        expect(mockedBulkWrite).toHaveBeenCalledTimes(1);
    });

    it('I3 - 部分更新应正确统计 inserted 和 updated', async () => {
        mockedBulkWrite.mockResolvedValue(
            fixtures.mockBulkWriteUpdateResult as any,
        );
        const result = await ingestMemoryFacts(makeFacts(3), ctx);
        expect(result.totalProcessed).toBe(3);
        expect(result.inserted).toBe(1);
        expect(result.updated).toBe(2);
    });

    it('I4 - bulkWrite 失败应抛出包装后的错误', async () => {
        mockedBulkWrite.mockRejectedValue(new Error('MongoDB connection lost'));
        await expect(ingestMemoryFacts(makeFacts(2), ctx)).rejects.toThrow(
            'Memory ingestion failed: MongoDB connection lost',
        );
    });

    it('I5 - 每条 fact 应生成一个 updateOne with upsert operation', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        const facts = makeFacts(2);
        await ingestMemoryFacts(facts, ctx);

        const operations = mockedBulkWrite.mock.calls[0]?.[0] as any[];
        expect(operations).toHaveLength(2);

        for (const op of operations) {
            expect(op.updateOne.upsert).toBe(true);
            expect(op.updateOne.filter).toHaveProperty('contentHash');
            expect(op.updateOne.filter).toHaveProperty(
                'userId',
                fixtures.mockUserId,
            );
            expect(op.updateOne.update.$set).toHaveProperty('content');
            expect(op.updateOne.update.$set).toHaveProperty('embedding');
            expect(op.updateOne.update.$set).toHaveProperty('confidence');
            expect(op.updateOne.update.$set).toHaveProperty('category');
            expect(op.updateOne.update.$set).toHaveProperty('metadata');
            expect(op.updateOne.update.$set).toHaveProperty('sourceMessageIds');
        }
    });

    it('I6 - userId 应从 context 注入每条 operation', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        await ingestMemoryFacts(makeFacts(1), ctx);

        const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0];
        expect(op.updateOne.filter.userId).toBe(fixtures.mockUserId);
    });

    it('I7 - upsert 的文档应计入 inserted 而非忽略', async () => {
        mockedBulkWrite.mockResolvedValue({
            insertedCount: 0,
            modifiedCount: 0,
            upsertedCount: 3,
            deletedCount: 0,
            matchedCount: 0,
        } as any);
        const result = await ingestMemoryFacts(makeFacts(3), ctx);
        expect(result.inserted).toBe(3);
        expect(result.updated).toBe(0);
    });

    // ────────────────────── 写入点2 + 软删复活 ──────────────────────

    it('M5-1 - 入库应打 lastSignificantAt 时间戳，并以 $unset 复活软删记录', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        const before = Date.now();

        await ingestMemoryFacts(makeFacts(1), ctx);

        const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0].updateOne;

        // 写入点2：入库即「被实质使用」
        const stamp = op.update.$set.lastSignificantAt as Date;
        expect(stamp).toBeInstanceOf(Date);
        expect(stamp.getTime()).toBeGreaterThanOrEqual(before);
        expect(stamp.getTime()).toBeLessThanOrEqual(Date.now());

        expect(op.update.$unset).toEqual({ deletedAt: '' });
    });

    it('M5-2 - 复活走 $unset 移除字段，而非 $set 成 null', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);

        await ingestMemoryFacts(makeFacts(1), ctx);

        const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0].updateOne;

        // 读路径判定的是 deletedAt: { $exists: false }，
        // 写成 $set: { deletedAt: null } 会让已删记录永久漏判（搜不到也不再复活）
        expect(op.update.$unset.deletedAt).toBe('');
        expect('deletedAt' in op.update.$set).toBe(false);
    });

    it('M5-3 - filter 仅含 userId + contentHash，不得混入 deletedAt', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);

        await ingestMemoryFacts(makeFacts(1), ctx);

        const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0].updateOne;

        // filter 一旦带上 deletedAt 过滤，软删的同 contentHash 记录就命中不到，复活失效
        expect(Object.keys(op.filter).sort()).toEqual(['contentHash', 'userId']);
        expect(op.filter.contentHash).toBe('hash_事实内容1');
        expect(op.filter.userId).toBe(fixtures.mockUserId);

        // $set 与 $setOnInsert 同字段会触发 MongoDB 路径冲突，
        // 故 lastSignificantAt 只能出现在 $set
        expect(op.update.$set).toHaveProperty('lastSignificantAt');
        expect('lastSignificantAt' in op.update.$setOnInsert).toBe(false);
    });

    // ────────────────────── M2 写入侧 tokenCount ──────────────────────

    /** 按 category 单条上限生成超长内容（不依赖固定 token 数的字面量） */
    function overCapContent(categoryCapMax: number): string {
        const unit = '这是一段会反复追加的事件细节描述。';
        let text = unit;
        while (countTokens(text) <= categoryCapMax) text += unit;
        return text;
    }

    /** 取第 i 条 operation 的 $set */
    function setOf(i = 0): any {
        return (mockedBulkWrite.mock.calls[0]?.[0] as any[])[i]!.updateOne.update
            .$set;
    }

    it('M2-1 - 短 fact 不改写 content，tokenCount 等于 countTokens(content)', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        const content = '用户偏好喝美式咖啡';

        await ingestMemoryFacts(
            [
                {
                    content,
                    confidence: 0.9,
                    category: 'preference',
                    embedding: [0.1],
                    sourceMessageIds: ['msg-1'],
                },
            ],
            ctx,
        );

        const set = setOf();
        expect(set.content).toBe(content);
        expect(set.tokenCount).toBe(countTokens(content));
        const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0].updateOne;
        expect(op.filter.contentHash).toBe(`hash_${content}`);
    });

    it('M2-2 - event 远超上限（800）也入库全量 content，tokenCount 基于全量计', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        const content = overCapContent(
            BUDGET_CONFIG.ltmCategoryTokenCap.event![1],
        );

        // 前置：构造的原文确实远超 category 上限，否则本用例什么都没验证
        const totalTokens = countTokens(content);
        expect(totalTokens).toBeGreaterThan(800);

        await ingestMemoryFacts(
            [
                {
                    content,
                    confidence: 0.9,
                    category: 'event',
                    embedding: [0.1, 0.2, 0.3],
                    sourceMessageIds: ['msg-1'],
                },
            ],
            ctx,
        );

        const set = setOf();
        // 入库不截断：content 是事实源，逐字保留
        expect(set.content).toBe(content);
        expect(set.tokenCount).toBe(totalTokens);
        expect(set.searchText).toBe(tokenize(content));

        const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0].updateOne;
        // 去重键同样基于全量 content
        expect(op.filter.contentHash).toBe(`hash_${content}`);
        // embedding 原样透传，维度不被改写（本就是按全量原文生成的）
        expect(set.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('M2-3 - category 缺省（other 上限 400）同样不截断，存储期与 category 无关', async () => {
        mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
        const content = overCapContent(
            BUDGET_CONFIG.ltmCategoryTokenCap.other![1],
        );
        const totalTokens = countTokens(content);
        expect(totalTokens).toBeGreaterThan(400);

        await ingestMemoryFacts(
            [
                {
                    content,
                    confidence: 0.9,
                    embedding: [0.4],
                    sourceMessageIds: ['msg-1'],
                },
            ],
            ctx,
        );

        const set = setOf();
        expect(set.content).toBe(content);
        expect(set.tokenCount).toBe(totalTokens);
        expect(set.category).toBeUndefined();
    });
});

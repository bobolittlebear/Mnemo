/**
 * 写入点1（检索路径标记 lastSignificantAt）单元测试
 *
 * 覆盖两块：
 * - collectMarkableIds 纯函数：按 vectorScore 与阈值筛选 _id，无副作用
 * - search() 触发语义：标记为 fire-and-forget，不阻塞、不改返回值、失败只 warn
 *
 * Mock 依赖：generateEmbedding, MemoryFact, logger, config
 * Spy 目标：vectorSearch, textSearch（私有方法）
 * 真实逻辑：rrfFusion —— 不 mock，用真实融合产出 fused，
 *           以验证「vectorScore 穿过 rrfFusion 后仍可被标记」这条集成链路
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RankedDoc } from '@/types/memory';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

const { loggerMock } = vi.hoisted(() => ({
    loggerMock: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => loggerMock,
}));

vi.mock('@/lib/embedding', () => ({
    generateEmbedding: vi.fn(),
}));

vi.mock('@/utils/config', () => ({
    EMBEDDING_DIMENSIONS: 1536,
    MEMORY_SELECTION_MIN_VECTOR_SCORE: 0.5,
}));

vi.mock('@/models/MemoryFact', () => ({
    MemoryFact: { aggregate: vi.fn(), updateMany: vi.fn() },
}));

// ── 引入被测模块（在 Mock 之后）──

import memorySearchService, {
    collectMarkableIds,
} from '@/services/memory/memorySearch.service';
import { generateEmbedding } from '@/lib/embedding';
import { MemoryFact } from '@/models/MemoryFact';

// ── 测试工具 ──

const THRESHOLD = 0.5;

function makeFakeEmbedding(dim = 1536): number[] {
    return Array(dim).fill(0.1);
}

function makeRankedDoc(
    id: string,
    rank: number,
    vectorScore?: number,
): RankedDoc {
    return {
        _id: id,
        content: `content of ${id}`,
        userId: 'test-key',
        confidence: 0.9,
        category: 'preference',
        type: 'fact',
        sourceMessageIds: ['msg-1'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        rank,
        rawScore: 1 - rank * 0.1,
        vectorScore,
    };
}

// ────────────────────── collectMarkableIds ──────────────────────

describe('collectMarkableIds', () => {
    it('M1: 混合分数下只返回达到阈值的项', () => {
        const ids = collectMarkableIds(
            [
                { _id: 'high', vectorScore: 0.9 },
                { _id: 'low', vectorScore: 0.3 },
            ],
            THRESHOLD,
        );

        expect(ids).toEqual(['high']);
    });

    it('M2: 多条达到阈值的项全部返回，且保持原顺序', () => {
        const ids = collectMarkableIds(
            [
                { _id: 'a', vectorScore: 0.5 },
                { _id: 'b', vectorScore: 0.72 },
                { _id: 'c', vectorScore: 0.99 },
            ],
            THRESHOLD,
        );

        expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('M3: vectorScore 缺失（纯关键词命中）不计入', () => {
        const ids = collectMarkableIds(
            [
                { _id: 'text-only' },
                { _id: 'with-vector', vectorScore: 0.8 },
            ],
            THRESHOLD,
        );

        expect(ids).toEqual(['with-vector']);
    });

    it('M4: 全部低于阈值返回空数组', () => {
        const ids = collectMarkableIds(
            [
                { _id: 'a', vectorScore: 0.49 },
                { _id: 'b', vectorScore: 0 },
            ],
            THRESHOLD,
        );

        expect(ids).toEqual([]);
    });

    it('M5: 空输入返回空数组', () => {
        expect(collectMarkableIds([], THRESHOLD)).toEqual([]);
    });
});

// ────────────────────── search() 触发语义 ──────────────────────

describe('MemorySearchService.search — 写入点1 标记', () => {
    let vectorSearchSpy: ReturnType<typeof vi.spyOn>;
    let textSearchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();

        vi.mocked(generateEmbedding).mockResolvedValue({
            totalTokens: 10,
            embeddings: [makeFakeEmbedding()],
        });

        // 默认 updateMany 成功
        (MemoryFact.updateMany as any).mockResolvedValue({
            matchedCount: 1,
            modifiedCount: 1,
        });

        vectorSearchSpy = vi
            .spyOn(memorySearchService as any, 'vectorSearch')
            .mockResolvedValue([]);
        textSearchSpy = vi
            .spyOn(memorySearchService as any, 'textSearch')
            .mockResolvedValue([]);
    });

    afterEach(() => {
        vectorSearchSpy.mockRestore();
        textSearchSpy.mockRestore();
    });

    it('S1: 高 vectorScore 候选触发 updateMany，filter 含 type/24h 窗口/$in', async () => {
        const before = Date.now();
        vectorSearchSpy.mockResolvedValue([
            makeRankedDoc('V1', 1, 0.95),
            makeRankedDoc('V2', 2, 0.8),
        ]);

        const result = await memorySearchService.search({
            userId: 'test-key',
            query: '标记测试',
        });

        // 返回值不受标记副作用影响
        expect(result.results.length).toBe(2);
        expect(result.degraded).toBe(false);

        expect(MemoryFact.updateMany).toBeCalledTimes(1);
        const [filter, update] = (MemoryFact.updateMany as any).mock.calls[0]!;

        // 只标记达到 A0 地板的向量候选
        expect(filter._id).toEqual({ $in: ['V1', 'V2'] });
        // 类型作用域：不得误标记 note_chunk / media
        expect(filter.type).toBe('fact');

        // 滚动 24h 窗口，且用 $not/$gte 以同时命中「字段缺失」的存量记忆
        const windowStart = filter.lastSignificantAt.$not.$gte as Date;
        expect(windowStart).toBeInstanceOf(Date);
        expect(Object.keys(filter.lastSignificantAt)).toEqual(['$not']);
        expect(Object.keys(filter.lastSignificantAt.$not)).toEqual(['$gte']);
        const expectedStart = before - 86_400_000;
        expect(Math.abs(windowStart.getTime() - expectedStart)).toBeLessThan(
            5000,
        );

        expect(update.$set.lastSignificantAt).toBeInstanceOf(Date);
        expect(Object.keys(update.$set)).toEqual(['lastSignificantAt']);
    });

    it('S2: 低分候选不触发 updateMany（避免噪声命中续命）', async () => {
        vectorSearchSpy.mockResolvedValue([
            makeRankedDoc('V1', 1, 0.3),
            makeRankedDoc('V2', 2, 0.1),
        ]);

        const result = await memorySearchService.search({
            userId: 'test-key',
            query: '噪声测试',
        });

        expect(result.results.length).toBe(2);
        expect(MemoryFact.updateMany).not.toBeCalled();
    });

    it('S3: 纯关键词命中（无 vectorScore）不触发 updateMany', async () => {
        textSearchSpy.mockResolvedValue([
            makeRankedDoc('T1', 1),
            makeRankedDoc('T2', 2),
        ]);

        const result = await memorySearchService.search({
            userId: 'test-key',
            query: '关键词测试',
        });

        expect(result.results.length).toBe(2);
        expect(MemoryFact.updateMany).not.toBeCalled();
    });

    it('S4: updateMany 失败时 search 仍正常返回，异常被 catch 为 warn', async () => {
        const dbError = new Error('mongo down');
        (MemoryFact.updateMany as any).mockRejectedValue(dbError);
        vectorSearchSpy.mockResolvedValue([makeRankedDoc('V1', 1, 0.95)]);

        const result = await memorySearchService.search({
            userId: 'test-key',
            query: '失败降级测试',
        });

        // 标记失败不得影响检索主链路
        expect(result.results.length).toBe(1);
        expect(result.degraded).toBe(false);

        // .catch 已挂上：等微任务队列排空后应记录 warn 而非抛出
        await Promise.resolve();
        await Promise.resolve();
        expect(loggerMock.warn).toBeCalledTimes(1);
        expect(loggerMock.warn.mock.calls[0]![0]).toBe('forget-mark-failed');
        expect(loggerMock.warn.mock.calls[0]![1]).toEqual({ error: dbError });
    });
});

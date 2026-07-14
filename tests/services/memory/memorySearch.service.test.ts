/**
 * MemorySearchService.search() 单元测试
 *
 * 测试目标：混合检索主编排流程（query 校验、参数解构、降级判定）
 * Mock 依赖：generateEmbedding, MemoryFact, logger, config
 * Spy 目标：vectorSearch, textSearch（私有方法）
 * 真实逻辑：rrfFusion（纯函数，已独立测试，不 mock）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RankedDoc } from '@/types/memory';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

vi.mock('@/lib/embedding', () => ({
    generateEmbedding: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

vi.mock('@/utils/config', () => ({
    EMBEDDING_DIMENSIONS: 1536,
}));

vi.mock('@/models/MemoryFact', () => ({
    MemoryFact: { aggregate: vi.fn() },
}));

// ── 引入被测模块（在 Mock 之后）──

import memorySearchService from '@/services/memory/memorySearch.service';
import { generateEmbedding } from '@/lib/embedding';
import { MemoryFact } from '@/models/MemoryFact';

// ── 测试工具 ──

const MOCK_DIM = 1536;

function makeFakeEmbedding(dim = MOCK_DIM): number[] {
    return Array(dim).fill(0.1);
}

function makeRankedDoc(id: string, rank: number): RankedDoc {
    return {
        _id: id,
        content: `content of ${id}`,
        memoryKey: 'test-key',
        confidence: 0.9,
        category: 'preference',
        type: 'fact',
        sourceMessageIds: ['msg-1'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        rank,
        rawScore: 1 - rank * 0.1,
    };
}

function makeNDocs(n: number, prefix = 'T'): RankedDoc[] {
    return Array.from({ length: n }, (_, i) =>
        makeRankedDoc(`${prefix}${i + 1}`, i + 1),
    );
}

/** 构造 aggregate mock 返回的文档（向量检索） */
function makeVectorDoc(id: string, vectorScore = 0.95) {
    return {
        _id: id,
        content: `content of ${id}`,
        memoryKey: 'test-key',
        confidence: 0.9,
        category: 'preference',
        type: 'fact',
        sourceMessageIds: ['msg-1'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        vectorScore,
    };
}

/** 构造 aggregate mock 返回的文档（关键词检索） */
function makeTextDoc(id: string, textScore = 1.5) {
    return {
        _id: id,
        content: `content of ${id}`,
        memoryKey: 'test-key',
        confidence: 0.9,
        category: 'preference',
        type: 'fact',
        sourceMessageIds: ['msg-1'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        textScore,
    };
}

// ── 测试 ──

describe('MemorySearchService.search', () => {
    let vectorSearchSpy: ReturnType<typeof vi.spyOn>;
    let textSearchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();

        // 默认：generateEmbedding 成功返回 1536 维向量
        vi.mocked(generateEmbedding).mockResolvedValue({
            totalTokens: 10,
            embeddings: [makeFakeEmbedding()],
        });

        // 默认：双路返回空
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

    // ────────────────────── Happy Path ──────────────────────

    it('S1: 双路正常返回且无重叠', async () => {
        vectorSearchSpy.mockResolvedValue(makeNDocs(3, 'V'));
        textSearchSpy.mockResolvedValue(makeNDocs(3, 'T'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '测试查询',
        });

        expect(result.results.length).toBe(6);
        expect(result.degraded).toBe(false);
        expect(result.vectorCount).toBe(3);
        expect(result.textCount).toBe(3);
        expect(generateEmbedding).toBeCalledTimes(1);
        expect(vi.mocked(generateEmbedding).mock.calls[0]![0]).toBe('测试查询');
    });

    it('S2: 双路有重叠文档，RRF跨路叠加正确', async () => {
        vectorSearchSpy.mockResolvedValue([
            makeRankedDoc('A', 1),
            makeRankedDoc('B', 2),
        ]);
        textSearchSpy.mockResolvedValue([
            makeRankedDoc('B', 1),
            makeRankedDoc('C', 2),
        ]);

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '重叠测试',
        });

        // 3 条唯一文档
        expect(result.results.length).toBe(3);
        expect(result.degraded).toBe(false);

        // B 的 rrfScore = 1/(k+2) + 1/(k+1)，k=60
        const docB = result.results.find((r) => r._id === 'B')!;
        const expectedScoreB = 1 / (60 + 2) + 1 / (60 + 1);
        expect(Math.abs(docB.rrfScore - expectedScoreB)).toBeLessThan(1e-6);
    });

    // ────────────────────── 空查询短路 ──────────────────────

    it('S3: Query 为空字符串，短路返回', async () => {
        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '',
        });

        expect(result.results).toEqual([]);
        expect(result.vectorCount).toBe(0);
        expect(result.textCount).toBe(0);
        expect(result.degraded).toBe(false);
        expect(generateEmbedding).not.toBeCalled();
    });

    it('S4: Query 仅含空白字符，trim 后短路', async () => {
        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '   ',
        });

        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(false);
        expect(generateEmbedding).not.toBeCalled();
    });

    // ────────────────────── Embedding 失败降级 ──────────────────────

    it('S5: Embedding 生成失败，降级为关键词检索', async () => {
        vi.mocked(generateEmbedding).mockRejectedValue(new Error('API 限流'));
        textSearchSpy.mockResolvedValue(makeNDocs(5, 'T'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '降级测试',
        });

        expect(result.results.length).toBe(5);
        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toContain('Embedding');
        expect(result.vectorCount).toBe(0);
        expect(vectorSearchSpy).not.toBeCalled();
    });

    it('S6: Embedding 维度不匹配，降级为关键词检索', async () => {
        vi.mocked(generateEmbedding).mockResolvedValue({
            totalTokens: 5,
            embeddings: [Array(512).fill(0.1)], // 512 ≠ 1536
        });
        textSearchSpy.mockResolvedValue(makeNDocs(5, 'T'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '维度测试',
        });

        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toContain('Embedding');
        expect(result.vectorCount).toBe(0);
        expect(vectorSearchSpy).not.toBeCalled();
    });

    // ────────────────────── 单路检索失败降级 ──────────────────────

    it('S7: 向量检索失败，降级使用关键词结果', async () => {
        vectorSearchSpy.mockRejectedValue(new Error('Atlas 超时'));
        textSearchSpy.mockResolvedValue(makeNDocs(4, 'T'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '向量失败测试',
        });

        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toBe('向量检索失败');
        expect(result.textCount).toBe(4);
    });

    it('S8: 关键词检索失败，降级使用向量结果', async () => {
        vectorSearchSpy.mockResolvedValue(makeNDocs(3, 'V'));
        textSearchSpy.mockRejectedValue(new Error('全文索引错误'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '关键词失败测试',
        });

        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toBe('关键词检索失败');
        expect(result.vectorCount).toBe(3);
    });

    // ────────────────────── 双管道均失败 ──────────────────────

    it('S9: 双管道均失败，安全返回空结果', async () => {
        vectorSearchSpy.mockRejectedValue(new Error('Atlas 超时'));
        textSearchSpy.mockRejectedValue(new Error('全文索引错误'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '全失败测试',
        });

        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toBe('双管道均失败');
    });

    // ────────────────────── 参数覆盖 ──────────────────────

    it('S10: 自定义参数透传到双路检索和 RRF', async () => {
        vectorSearchSpy.mockResolvedValue([makeRankedDoc('A', 1)]);
        textSearchSpy.mockResolvedValue([makeRankedDoc('A', 2)]);

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '参数测试',
            vectorTopK: 50,
            textTopK: 50,
            finalTopN: 5,
            rrfK: 30,
        });

        // vectorSearch(memoryKey, embedding, topK=50, numCandidates=100, ...)
        expect(vectorSearchSpy).toHaveBeenCalledWith(
            'test-key',
            expect.any(Array),
            50,
            100,
            undefined,
            undefined,
        );

        // textSearch(memoryKey, query, topK=50, ...)
        expect(textSearchSpy).toHaveBeenCalledWith(
            'test-key',
            '参数测试',
            50,
            undefined,
            undefined,
        );

        // 最终结果 ≤ 5
        expect(result.results.length).toBeLessThanOrEqual(5);

        // RRF k=30：A 出现在两路 rank=1 和 rank=2
        const expectedScore = 1 / (30 + 1) + 1 / (30 + 2);
        expect(
            Math.abs(result.results[0]!.rrfScore - expectedScore),
        ).toBeLessThan(1e-6);
    });

    // ────────────────────── 参数精确断言 ──────────────────────

    it('S11: query 传入 generateEmbedding 前已 trim', async () => {
        await memorySearchService.search({
            memoryKey: 'test-key',
            query: '  hello world  ',
        });

        expect(generateEmbedding).toHaveBeenCalledWith('hello world');
    });

    it('S12: notebookId + type 过滤条件传递到双路检索', async () => {
        await memorySearchService.search({
            memoryKey: 'test-key',
            query: '过滤测试',
            notebookId: 'nb1',
            type: 'fact',
        });

        expect(vectorSearchSpy).toHaveBeenCalledWith(
            'test-key',
            expect.any(Array),
            20,
            100,
            'nb1',
            'fact',
        );
        expect(textSearchSpy).toHaveBeenCalledWith(
            'test-key',
            '过滤测试',
            20,
            'nb1',
            'fact',
        );
    });

    // ────────────────────── 降级路径二次失败 ──────────────────────

    it('S13: Embedding 失败后关键词也失败，全管道降级', async () => {
        vi.mocked(generateEmbedding).mockRejectedValue(new Error('API 限流'));
        textSearchSpy.mockRejectedValue(new Error('全文索引错误'));

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '全降级测试',
        });

        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toBe('所有检索管道均失败');
    });

    // ────────────────────── 补充 edge cases ──────────────────────

    it('E1: query 为 undefined，短路返回不触发降级', async () => {
        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: undefined as any,
        });

        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(false);
        expect(generateEmbedding).not.toBeCalled();
    });

    it('E2: generateEmbedding 返回空 embeddings 数组，降级', async () => {
        vi.mocked(generateEmbedding).mockResolvedValue({
            totalTokens: 0,
            embeddings: [], // embeddings[0]! → undefined → .length throws
        });
        textSearchSpy.mockResolvedValue([makeRankedDoc('A', 1)]);

        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '空embeddings测试',
        });

        expect(result.degraded).toBe(true);
        expect(result.vectorCount).toBe(0);
    });

    it('E3: 多次调用 search 不泄漏状态', async () => {
        // 第一次：正常
        vectorSearchSpy.mockResolvedValue([makeRankedDoc('A', 1)]);
        textSearchSpy.mockResolvedValue([makeRankedDoc('B', 1)]);

        const result1 = await memorySearchService.search({
            memoryKey: 'key1',
            query: '第一次',
        });

        // 第二次：向量失败
        vectorSearchSpy.mockRejectedValue(new Error('失败'));
        textSearchSpy.mockResolvedValue([makeRankedDoc('C', 1)]);

        const result2 = await memorySearchService.search({
            memoryKey: 'key2',
            query: '第二次',
        });

        expect(result1.degraded).toBe(false);
        expect(result2.degraded).toBe(true);
    });

    it('E4: vectorSearch 第二个参数是 embedding 向量（非 query 文本）', async () => {
        const fakeVec = makeFakeEmbedding();
        vi.mocked(generateEmbedding).mockResolvedValue({
            totalTokens: 10,
            embeddings: [fakeVec],
        });

        await memorySearchService.search({
            memoryKey: 'test-key',
            query: '向量验证',
        });

        const callArgs = vectorSearchSpy.mock.calls[0]!;
        expect(Array.isArray(callArgs[1])).toBe(true);
        expect(callArgs[1].length).toBe(MOCK_DIM);
    });

    it('E5: textSearch 第二个参数是 trimmed query 字符串（非 embedding）', async () => {
        await memorySearchService.search({
            memoryKey: 'test-key',
            query: '  关键词验证  ',
        });

        const callArgs = textSearchSpy.mock.calls[0]!;
        expect(typeof callArgs[1]).toBe('string');
        expect(callArgs[1]).toBe('关键词验证');
    });

    it('E6: 未指定参数时使用默认值（vectorTopK=20, textTopK=20, numCandidates=100）', async () => {
        await memorySearchService.search({
            memoryKey: 'test-key',
            query: '默认参数',
        });

        // vectorSearch(memoryKey, embedding, topK=20, numCandidates=100, ...)
        expect(vectorSearchSpy).toHaveBeenCalledWith(
            'test-key',
            expect.any(Array),
            20,
            100,
            undefined,
            undefined,
        );

        // textSearch(memoryKey, query, topK=20, ...)
        expect(textSearchSpy).toHaveBeenCalledWith(
            'test-key',
            '默认参数',
            20,
            undefined,
            undefined,
        );
    });

    it('E7: 双路均返回 0 条结果，degraded 为 false', async () => {
        const result = await memorySearchService.search({
            memoryKey: 'test-key',
            query: '无结果测试',
        });

        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(false);
        expect(result.vectorCount).toBe(0);
        expect(result.textCount).toBe(0);
    });

    it('E8: 仅指定 notebookId 不指定 type，type 参数为 undefined', async () => {
        await memorySearchService.search({
            memoryKey: 'test-key',
            query: '部分过滤',
            notebookId: 'nb1',
        });

        expect(vectorSearchSpy).toHaveBeenCalledWith(
            'test-key',
            expect.any(Array),
            20,
            100,
            'nb1',
            undefined, // type 未传
        );
        expect(textSearchSpy).toHaveBeenCalledWith(
            'test-key',
            '部分过滤',
            20,
            'nb1',
            undefined,
        );
    });
});

// ────────────────────── vectorSearch 聚合管道测试 ──────────────────────

describe('MemorySearchService.vectorSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('S14: 管道结构包含 $vectorSearch + $addFields + $project', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([
            makeVectorDoc('A', 0.95),
        ]);

        await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
        );

        expect(MemoryFact.aggregate).toBeCalledTimes(1);

        const pipeline = (MemoryFact.aggregate as any).mock
            .calls[0]![0] as any[];

        // 阶段 1: $vectorSearch
        const vs = pipeline[0].$vectorSearch;
        expect(vs.index).toBe('autoembed_index');
        expect(vs.path).toBe('embedding');
        expect(vs.numCandidates).toBe(100);
        expect(vs.limit).toBe(20);
        expect(Array.isArray(vs.queryVector)).toBe(true);
        expect(vs.queryVector.length).toBe(MOCK_DIM);

        // 阶段 2: $addFields
        expect(pipeline[1].$addFields.vectorScore).toEqual({
            $meta: 'vectorSearchScore',
        });

        // 阶段 3: $project
        expect(pipeline[2].$project).toBeDefined();
        expect(pipeline[2].$project.vectorScore).toBe(1);
        expect(pipeline[2].$project.content).toBe(1);
        expect(pipeline[2].$project.memoryKey).toBe(1);
    });

    it('S15: memoryKey 必选过滤', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).vectorSearch(
            'my-memory-key',
            makeFakeEmbedding(),
            20,
            100,
        );

        const pipeline = (MemoryFact.aggregate as any).mock
            .calls[0]![0] as any[];
        const filter = pipeline[0].$vectorSearch.filter;

        expect(filter.memoryKey).toEqual({ $eq: 'my-memory-key' });
    });

    it('S16: notebookId + type 组合过滤动态拼接', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
            'nb1',
            'fact',
        );

        const pipeline = (MemoryFact.aggregate as any).mock
            .calls[0]![0] as any[];
        const filter = pipeline[0].$vectorSearch.filter;

        expect(filter.memoryKey).toEqual({ $eq: 'test-key' });
        expect(filter.notebookId).toEqual({ $eq: 'nb1' });
        expect(filter.type).toEqual({ $eq: 'fact' });
    });

    it('S17: rank 赋值正确性（1-based），rawScore 取自 vectorSearchScore', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([
            makeVectorDoc('A', 0.95),
            makeVectorDoc('B', 0.85),
            makeVectorDoc('C', 0.75),
        ]);

        const result = await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
        );

        expect(result.length).toBe(3);
        expect(result[0].rank).toBe(1);
        expect(result[0].rawScore).toBe(0.95);
        expect(result[1].rank).toBe(2);
        expect(result[1].rawScore).toBe(0.85);
        expect(result[2].rank).toBe(3);
        expect(result[2].rawScore).toBe(0.75);
    });

    // ── vectorSearch edge cases ──

    it('E9: aggregate 抛错时错误向上传播', async () => {
        (MemoryFact.aggregate as any).mockRejectedValue(
            new Error('Atlas 连接超时'),
        );

        await expect(
            (memorySearchService as any).vectorSearch(
                'test-key',
                makeFakeEmbedding(),
                20,
                100,
            ),
        ).rejects.toThrow('Atlas 连接超时');
    });

    it('E10: aggregate 返回空数组，rank 映射结果为空', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        const result = await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
        );

        expect(result).toEqual([]);
    });

    it('E11: aggregate 返回的 doc 缺少 vectorScore，rawScore 降级为 0', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([
            { ...makeVectorDoc('A'), vectorScore: undefined },
        ]);

        const result = await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
        );

        expect(result[0].rawScore).toBe(0);
    });

    it('E12: topK 和 numCandidates 参数透传到管道', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            50,
            200,
        );

        const pipeline = (MemoryFact.aggregate as any).mock
            .calls[0]![0] as any[];
        expect(pipeline[0].$vectorSearch.limit).toBe(50);
        expect(pipeline[0].$vectorSearch.numCandidates).toBe(200);
    });

    it('E13: 仅传 notebookId 不传 type，filter 不含 type 键', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
            'nb1',
            // type 未传
        );

        const filter = (MemoryFact.aggregate as any).mock.calls[0]![0][0]
            .$vectorSearch.filter;
        expect(filter.notebookId).toEqual({ $eq: 'nb1' });
        expect(filter.type).toBeUndefined();
    });

    it('E14: 不传 notebookId 和 type，filter 仅含 memoryKey', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).vectorSearch(
            'test-key',
            makeFakeEmbedding(),
            20,
            100,
        );

        const filter = (MemoryFact.aggregate as any).mock.calls[0]![0][0]
            .$vectorSearch.filter;
        expect(Object.keys(filter)).toEqual(['memoryKey']);
    });
});

// ────────────────────── textSearch 全文检索测试 ──────────────────────

describe('MemorySearchService.textSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('S18: 管道结构包含 $match → $addFields → $sort → $limit → $project', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([
            makeTextDoc('A', 1.5),
        ]);

        await (memorySearchService as any).textSearch('test-key', '搜索词', 20);

        expect(MemoryFact.aggregate).toBeCalledTimes(1);

        const pipeline = (MemoryFact.aggregate as any).mock
            .calls[0]![0] as any[];

        // 5 个阶段
        expect(pipeline.length).toBe(5);

        // 阶段 1: $match
        expect(pipeline[0].$match).toBeDefined();
        expect(pipeline[0].$match.$text).toEqual({ $search: '搜索词' });

        // 阶段 2: $addFields
        expect(pipeline[1].$addFields.textScore).toEqual({
            $meta: 'textScore',
        });

        // 阶段 3: $sort
        expect(pipeline[2].$sort.textScore).toBe(-1);

        // 阶段 4: $limit
        expect(pipeline[3].$limit).toBe(20);

        // 阶段 5: $project
        expect(pipeline[4].$project).toBeDefined();
        expect(pipeline[4].$project.textScore).toBe(1);
        expect(pipeline[4].$project.content).toBe(1);
    });

    it('S19: $match 同时包含 $text 和 memoryKey', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).textSearch('my-key', '搜索词', 20);

        const match = (MemoryFact.aggregate as any).mock.calls[0]![0][0].$match;

        expect(match.$text).toEqual({ $search: '搜索词' });
        expect(match.memoryKey).toBe('my-key');
    });

    it('S20: rank 与 rawScore 映射（1-based，rawScore 取自 textScore）', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([
            makeTextDoc('A', 2.0),
            makeTextDoc('B', 1.5),
        ]);

        const result = await (memorySearchService as any).textSearch(
            'test-key',
            '搜索词',
            20,
        );

        expect(result.length).toBe(2);
        expect(result[0].rank).toBe(1);
        expect(result[0].rawScore).toBe(2.0);
        expect(result[1].rank).toBe(2);
        expect(result[1].rawScore).toBe(1.5);
    });

    // ── textSearch edge cases ──

    it('E15: aggregate 抛错时错误向上传播', async () => {
        (MemoryFact.aggregate as any).mockRejectedValue(
            new Error('全文索引错误'),
        );

        await expect(
            (memorySearchService as any).textSearch('test-key', '搜索词', 20),
        ).rejects.toThrow('全文索引错误');
    });

    it('E16: aggregate 返回空数组，结果为空', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        const result = await (memorySearchService as any).textSearch(
            'test-key',
            '搜索词',
            20,
        );

        expect(result).toEqual([]);
    });

    it('E17: aggregate 返回的 doc 缺少 textScore，rawScore 降级为 0', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([
            { ...makeTextDoc('A'), textScore: undefined },
        ]);

        const result = await (memorySearchService as any).textSearch(
            'test-key',
            '搜索词',
            20,
        );

        expect(result[0].rawScore).toBe(0);
    });

    it('E18: topK 参数透传到 $limit 阶段', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).textSearch('test-key', '搜索词', 50);

        const pipeline = (MemoryFact.aggregate as any).mock
            .calls[0]![0] as any[];
        expect(pipeline[3].$limit).toBe(50);
    });

    it('E19: notebookId + type 透传到 $match', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).textSearch(
            'test-key',
            '搜索词',
            20,
            'nb1',
            'fact',
        );

        const match = (MemoryFact.aggregate as any).mock.calls[0]![0][0].$match;

        expect(match.memoryKey).toBe('test-key');
        expect(match.notebookId).toBe('nb1');
        expect(match.type).toBe('fact');
    });

    it('E20: 不传 notebookId 和 type，$match 仅含 $text 和 memoryKey', async () => {
        (MemoryFact.aggregate as any).mockResolvedValue([]);

        await (memorySearchService as any).textSearch('test-key', '搜索词', 20);

        const match = (MemoryFact.aggregate as any).mock.calls[0]![0][0].$match;

        expect(Object.keys(match).sort()).toEqual(['$text', 'memoryKey']);
    });
});

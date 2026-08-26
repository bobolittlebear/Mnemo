/**
 * noteSearch.service.ts 单元测试
 *
 * 测试目标：searchNotes 双路检索（向量 + BM25）→ RRF(k=60) 融合 → 父子块上下文展开
 * Mock 依赖：generateEmbedding, tokenize, NoteChunk.aggregate, NoteChunk.find, logger
 * 真实逻辑：RRF 融合（本地实现）、parentId 回填、结果排序
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

vi.mock('@/lib/embedding', () => ({
    generateEmbedding: vi.fn(),
}));

vi.mock('@/utils/tokenizer', () => ({
    tokenize: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

vi.mock('@/models/NoteChunk', () => ({
    NoteChunk: { aggregate: vi.fn(), find: vi.fn() },
}));

// ── 引入被测模块（在 Mock 之后）──

import { searchNotes } from '@/services/notebook/noteSearch.service';
import { generateEmbedding } from '@/lib/embedding';
import { tokenize } from '@/utils/tokenizer';
import { NoteChunk } from '@/models/NoteChunk';

// ── 测试工具 ──

const NB_ID = '000000000000000000000001';
const NB_ID_2 = '000000000000000000000002';
const RRF_K = 60;

function makeEmbedding(): number[] {
    return Array(1536).fill(0.1);
}

interface MockChunk {
    _id: string;
    noteId: string;
    notebookId: string;
    title: string;
    sectionPath: string[];
    chunkIndex: number;
    content: string;
    parentId?: string | null;
}

function makeChunk(id: string, overrides: Partial<MockChunk> = {}): MockChunk {
    return {
        _id: id,
        noteId: `note-${id}`,
        notebookId: NB_ID,
        title: '部署指南',
        sectionPath: ['部署', '环境配置'],
        chunkIndex: 0,
        content: `内容 ${id}`,
        parentId: `parent-${id}`,
        ...overrides,
    };
}

/** 让 aggregate 第一次调用（向量路）与第二次调用（BM25 路）返回指定候选 */
function mockAggregate(vectorDocs: MockChunk[], textDocs: MockChunk[]): void {
    (NoteChunk.aggregate as any)
        .mockResolvedValueOnce(vectorDocs)
        .mockResolvedValueOnce(textDocs);
}

/** 让 NoteChunk.find(...).select(...).lean() 返回 parent 列表 */
function mockFindReturn(
    parents: Array<{ _id: string; content: string }>,
): void {
    (NoteChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(parents),
        }),
    });
}

function parentsFor(children: MockChunk[]): Array<{ _id: string; content: string }> {
    return children.map((c) => ({
        _id: c.parentId ?? `parent-${c._id}`,
        content: `parent-${c._id}`,
    }));
}

/** 聚合管道取回：calls[callIndex][0] 即 pipeline */
function pipelineAt(callIndex: number): any[] {
    return (NoteChunk.aggregate as any).mock.calls[callIndex]![0];
}

/** 强断言：实际值在期望 ±epsilon 内 */
function expectClose(actual: number, expected: number, epsilon = 1e-6) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
}

// ── 测试 ──

describe('noteSearch.searchNotes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(generateEmbedding).mockResolvedValue({
            totalTokens: 5,
            embeddings: [makeEmbedding()],
        });
        vi.mocked(tokenize).mockImplementation((text: string) => `tok:${text}`);
        mockFindReturn([]);
    });

    // ────────────────────── Happy Path ──────────────────────

    it('H1: 双路命中，RRF 融合后按融合分降序，top1 符合预期且父子回填正确', async () => {
        const a = makeChunk('A');
        const b = makeChunk('B');
        const c = makeChunk('C');
        // 向量路：A rank0, B rank1；BM25 路：B rank0, C rank1
        mockAggregate([a, b], [b, c]);
        mockFindReturn(parentsFor([a, b, c]));

        const results = await searchNotes({
            userId: 'u1',
            query: '部署指南',
        });

        // B = 1/60 + 1/61 最高；A = 1/60 > C = 1/61
        expect(results.length).toBe(3);
        expect(results[0]!.noteId).toBe('note-B');
        expect(results[0]!.score).toBeCloseTo(1 / RRF_K + 1 / (RRF_K + 1), 6);
        expect(results[1]!.noteId).toBe('note-A');
        expect(results[2]!.noteId).toBe('note-C');
        // 融合分严格降序
        expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
        expect(results[1]!.score).toBeGreaterThan(results[2]!.score);
        // 字段由 child 填充
        expect(results[0]!.content).toBe('内容 B');
        expect(results[0]!.title).toBe('部署指南');
        expect(results[0]!.sectionPath).toEqual(['部署', '环境配置']);
        expect(results[0]!.notebookId).toBe(NB_ID);
        // 父子回填：B 的 parentContext 来自 parent-B
        expect(results[0]!.parentContext).toBe('parent-B');
        expect(results[2]!.parentContext).toBe('parent-C');

        // 自审：真实调用次数与入参
        expect(generateEmbedding).toHaveBeenCalledTimes(1);
        expect(vi.mocked(generateEmbedding).mock.calls[0]![0]).toBe('部署指南');
        expect(NoteChunk.aggregate).toHaveBeenCalledTimes(2);
        expect(NoteChunk.find).toHaveBeenCalledWith({
            _id: { $in: ['parent-B', 'parent-A', 'parent-C'] },
        });
    });

    it('H2: notebookId 隔离，只返回指定笔记本的结果', async () => {
        const nb1Chunk = makeChunk('A'); // 默认 NB_ID
        const nb2Chunk = makeChunk('B', { notebookId: NB_ID_2 });
        // 传入 NB_ID_2 时，两路候选只含 nb2 的块
        mockAggregate([nb2Chunk], [nb2Chunk]);
        mockFindReturn(parentsFor([nb2Chunk]));

        const results = await searchNotes({
            userId: 'u1',
            query: '部署指南',
            notebookId: NB_ID_2,
        });

        expect(results.length).toBe(1);
        expect(results[0]!.notebookId).toBe(NB_ID_2);
        expect(results[0]!.noteId).toBe('note-B');
        // nb1 的块不应出现在结果中
        expect(results.some((r) => r.notebookId === NB_ID)).toBe(false);

        // 两路过滤条件都带上 notebookId
        const vectorFilter = pipelineAt(0)![0].$vectorSearch.filter;
        expect(vectorFilter.notebookId.$eq.toString()).toBe(NB_ID_2);
        const textMatch = pipelineAt(1)![2].$match;
        expect(textMatch.notebookId.toString()).toBe(NB_ID_2);
    });

    // ────────────────────── 空查询短路 ──────────────────────

    it('E1: query 为空或纯空白，返回 [] 且不调用 embedding 与 DB', async () => {
        const empty1 = await searchNotes({ userId: 'u1', query: '' });
        const empty2 = await searchNotes({ userId: 'u1', query: '   ' });

        expect(empty1).toEqual([]);
        expect(empty2).toEqual([]);
        expect(generateEmbedding).not.toHaveBeenCalled();
        expect(NoteChunk.aggregate).not.toHaveBeenCalled();
        expect(NoteChunk.find).not.toHaveBeenCalled();
    });

    // ────────────────────── 无命中 ──────────────────────

    it('E2: 两路均无命中，返回 []，不触发 parent 查询', async () => {
        mockAggregate([], []);

        const results = await searchNotes({ userId: 'u1', query: '无匹配词' });

        expect(results).toEqual([]);
        expect(NoteChunk.find).not.toHaveBeenCalled();
    });

    // ────────────────────── 单路命中 ──────────────────────

    it('E3: 仅向量路命中、BM25 为空，RRF 单路生效且 score 正确', async () => {
        const a = makeChunk('A');
        mockAggregate([a], []);

        const results = await searchNotes({ userId: 'u1', query: '部署指南' });

        expect(results.length).toBe(1);
        expect(results[0]!.noteId).toBe('note-A');
        expectClose(results[0]!.score, 1 / RRF_K); // rank0 → 1/60
    });

    it('E4: 仅 BM25 命中、向量为空，反向单路正常', async () => {
        const a = makeChunk('A');
        mockAggregate([], [a]);

        const results = await searchNotes({ userId: 'u1', query: '部署指南' });

        expect(results.length).toBe(1);
        expect(results[0]!.noteId).toBe('note-A');
        expectClose(results[0]!.score, 1 / RRF_K);
    });

    // ────────────────────── 跨路得分叠加 ──────────────────────

    it('E5: 同一 doc 同时出现在两路，融合分为两路分值之和且大于任一单路分', async () => {
        const a = makeChunk('A');
        mockAggregate([a], [a]); // 向量 rank0，BM25 rank0

        const results = await searchNotes({ userId: 'u1', query: '部署指南' });

        expect(results.length).toBe(1);
        const singlePath = 1 / RRF_K;
        const expectedSum = singlePath + singlePath;
        expectClose(results[0]!.score, expectedSum);
        expect(results[0]!.score).toBeGreaterThan(singlePath);
    });

    // ────────────────────── 父子展开边界 ──────────────────────

    it('E6: 孤儿 child（parentId 指向不存在块）→ parentContext 为空串且不抛错', async () => {
        const a = makeChunk('A');
        mockAggregate([a], []);
        mockFindReturn([]); // 数据库查不到 parent

        const results = await searchNotes({ userId: 'u1', query: '部署指南' });

        expect(results.length).toBe(1);
        expect(results[0]!.parentContext).toBe('');
        expect(NoteChunk.find).toHaveBeenCalledWith({ _id: { $in: ['parent-A'] } });
    });

    it('E7: parentId 为空时 parentContext 为空串', async () => {
        const a = makeChunk('A', { parentId: null });
        mockAggregate([a], []);

        const results = await searchNotes({ userId: 'u1', query: '部署指南' });

        expect(results.length).toBe(1);
        expect(results[0]!.parentContext).toBe('');
        expect(NoteChunk.find).not.toHaveBeenCalled(); // 无 parentId，不查 parent
    });

    // ────────────────────── topK 截断 ──────────────────────

    it('E8: 候选数 > topK，结果严格不超过 topK 条，候选取 topK*2', async () => {
        const chunks = ['A', 'B', 'C', 'D'].map((id) => makeChunk(id));
        mockAggregate(chunks, []); // 向量 4 个候选

        const results = await searchNotes({ userId: 'u1', query: '部署指南', topK: 2 });

        expect(results.length).toBe(2);
        expect(results[0]!.noteId).toBe('note-A');
        expect(results[1]!.noteId).toBe('note-B');
        // 向量路 limit = topK*2 = 4
        expect(pipelineAt(0)![0].$vectorSearch.limit).toBe(4);
    });

    // ────────────────────── 过滤精确性 ──────────────────────

    it('E9: 过滤条件精确为 userId + notebookId + chunkType 交集', async () => {
        mockAggregate([makeChunk('A', { notebookId: NB_ID_2 })], []);
        mockFindReturn([]);

        await searchNotes({ userId: 'u1', query: '部署指南', notebookId: NB_ID_2 });

        const vectorFilter = pipelineAt(0)![0].$vectorSearch.filter;
        expect(Object.keys(vectorFilter).sort()).toEqual([
            'chunkType',
            'notebookId',
            'userId',
        ]);
        expect(vectorFilter.userId).toEqual({ $eq: 'u1' });
        expect(vectorFilter.chunkType).toEqual({ $eq: 'child' });

        const textMatch = pipelineAt(1)![2].$match;
        expect(Object.keys(textMatch).sort()).toEqual([
            'chunkType',
            'notebookId',
            'userId',
        ]);
        expect(textMatch.userId).toBe('u1');
        expect(textMatch.chunkType).toBe('child');
    });

    it('E10: 不传 notebookId 时，过滤条件不含 notebookId 键', async () => {
        mockAggregate([makeChunk('A')], []);

        await searchNotes({ userId: 'u1', query: '部署指南' });

        const vectorFilter = pipelineAt(0)![0].$vectorSearch.filter;
        expect(Object.keys(vectorFilter).sort()).toEqual(['chunkType', 'userId']);
        const textMatch = pipelineAt(1)![2].$match;
        expect(Object.keys(textMatch).sort()).toEqual(['chunkType', 'userId']);
    });

    // ────────────────────── 管道结构 ──────────────────────

    it('P1: 向量管道 = $vectorSearch + $project，索引/路径/过滤正确', async () => {
        mockAggregate([makeChunk('A')], []);

        await searchNotes({ userId: 'u1', query: '部署指南' });

        const pipeline = pipelineAt(0);
        expect(pipeline.length).toBe(2);
        const vs = pipeline[0].$vectorSearch;
        expect(vs.index).toBe('vector_index');
        expect(vs.path).toBe('embedding');
        expect(Array.isArray(vs.queryVector)).toBe(true);
        expect(vs.queryVector.length).toBe(1536);
        expect(vs.limit).toBe(16); // topK(8) * 2
        expect(vs.filter.chunkType).toEqual({ $eq: 'child' });
        // $project 携带结果填充所需字段
        const projection = pipeline[1].$project;
        for (const field of ['_id', 'noteId', 'notebookId', 'title', 'sectionPath', 'chunkIndex', 'content', 'parentId']) {
            expect(projection[field]).toBe(1);
        }
    });

    it('P2: 文本管道 = $text → $addFields → $match(filter) → $sort → $limit → $project', async () => {
        mockAggregate([], [makeChunk('A')]);

        await searchNotes({ userId: 'u1', query: '部署指南' });

        const pipeline = pipelineAt(1);
        expect(pipeline.length).toBe(6);
        expect(pipeline[0].$match.$text).toEqual({ $search: 'tok:部署指南' });
        expect(pipeline[1].$addFields.textScore).toEqual({ $meta: 'textScore' });
        expect(pipeline[2].$match.userId).toBe('u1');
        expect(pipeline[2].$match.chunkType).toBe('child');
        expect(pipeline[3].$sort.textScore).toBe(-1);
        expect(pipeline[4].$limit).toBe(16);
        // tokenize 收到的是 trim 后的 query
        expect(tokenize).toHaveBeenCalledWith('部署指南');
    });

    // ────────────────────── 错误传播（不吞异常）──────────────────────

    it('P3: embedding 异常向上抛错，不静默返回空结果', async () => {
        vi.mocked(generateEmbedding).mockRejectedValue(new Error('Embedding API 限流'));

        await expect(
            searchNotes({ userId: 'u1', query: '部署指南' }),
        ).rejects.toThrow('Embedding API 限流');
        expect(NoteChunk.aggregate).not.toHaveBeenCalled();
    });

    // ────────────────────── 单路降级（Promise.allSettled）──────────────────────

    it('P4: 向量路异常降级，不抛错且仍可返回 BM25 结果', async () => {
        // 第一次 aggregate（向量路）reject，第二次（BM25）正常返回
        (NoteChunk.aggregate as any)
            .mockRejectedValueOnce(new Error('Atlas 连接超时'))
            .mockResolvedValueOnce([makeChunk('A')]);

        const results = await searchNotes({ userId: 'u1',  query: '部署指南' });

        // 不抛错，降级为仅 BM25 路生效
        expect(results.length).toBe(1);
        expect(results[0]!.noteId).toBe('note-A');
        // 两路都被调用（向量失败后 BM25 仍执行）
        expect(NoteChunk.aggregate).toHaveBeenCalledTimes( 2);
    });

    it('P5: BM25 路异常降级，不抛错且仍可返回向量结果', async () => {
        (NoteChunk.aggregate as any)
            .mockResolvedValueOnce([makeChunk('A')]) // 向量正常
            .mockRejectedValueOnce(new Error('text index 未建'));

        const results = await searchNotes({ userId: 'u1',  query: '部署指南' });

        expect(results.length).toBe(1);
        expect(results[0]!.noteId).toBe('note-A');
        expect(NoteChunk.aggregate).toHaveBeenCalledTimes(2);
    });

    it('P6: 两路都异常，返回 [] 不抛错（由注入层兜底）', async () => {
        (NoteChunk.aggregate as any)
            .mockRejectedValueOnce(new Error('vector down'))
            .mockRejectedValueOnce(new Error('text down'));

        const results = await searchNotes({ userId: 'u1',  query: '部署指南' });

        expect(results).toEqual([]);
    });
});

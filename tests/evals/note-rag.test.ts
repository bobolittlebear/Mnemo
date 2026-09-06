/**
 * 笔记 RAG 端到端 Snapshot 评测
 * 只验证结构正确性，如：过滤/父子回填/增量 diff，不评估 RAG 质量
 *
 * 读取 datasets/note-rag.golden.json 中的评测集，按 kind 分支执行：
 * - chunk   ：复用真实 chunkMarkdown，精确断言切分结果 + 整图 snapshot
 * - reindex ：mock Note/NoteChunk/embedding，在内存 fakeDB 上跑两次 incrementalReindex，
 *             断言首次全量与二次增量 diff 的 ReindexResult + snapshot
 * - search  ：mock embedding/NoteChunk，验证 notebookId 过滤与父子回填 + snapshot
 *
 * 所有 DB / embedding 均为 vi.mock 注入，不连真实 MongoDB / Atlas / embedding API，离线可跑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { chunkMarkdown, buildRetrievalText } from '@/utils/noteChunker';
import { countTokens } from '@/utils/tokenizer';
import { generateContentHash } from '@/utils/tool';
import type { ReindexResult } from '@/services/notebook/noteReindex.service';
import dataset from './datasets/note-rag.golden.json';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

vi.mock('@/models/Note', () => ({ default: { findOne: vi.fn() } }));
vi.mock('@/models/NoteChunk', () => ({
    NoteChunk: {
        find: vi.fn(),
        insertMany: vi.fn(),
        bulkWrite: vi.fn(),
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
        exists: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn(),
    },
}));
vi.mock('@/lib/embedding', () => ({
    generateEmbedding: vi.fn(),
    generateEmbeddings: vi.fn(),
}));
vi.mock('@/lib/redis', () => ({
    default: {
        sAdd: vi.fn(),
        sRem: vi.fn(),
        sMembers: vi.fn(),
        del: vi.fn(),
        incr: vi.fn(),
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

// ── 引入被测模块（在 Mock 之后）──

import { incrementalReindex } from '@/services/notebook/noteReindex.service';
import { searchNotes } from '@/services/notebook/noteSearch.service';
import { generateEmbedding, generateEmbeddings } from '@/lib/embedding';
import NoteModel from '@/models/Note';
import { NoteChunk } from '@/models/NoteChunk';

// ── 类型 ──────────────────────────────────────────────────────

interface ChunkExpected {
    parentCount: number;
    childCount: number;
    sectionPaths: string[][];
    childSectionPaths?: string[][];
    forcedSplitCount: number;
    contains?: string[];
    notContains?: string[];
}

interface ReindexExpected {
    parentsInserted?: number;
    parentsDeleted?: number;
    childrenInserted?: number;
    childrenDeleted?: number;
    childrenReParented?: number;
    unchanged?: number;
    embeddingTokensGt?: boolean;
    skipReason?: string;
    /** 标题变更场景：re-parent 就地重 embed（childrenReParented 对应子块带 embedding/searchText） */
    reParentEmbed?: boolean;
}

interface SearchExpected {
    resultsCount?: number;
    allMatchNotebookId?: boolean;
    topHasParentContext?: boolean;
    parentContextContains?: string;
}

interface SeedChunk {
    _id: string;
    chunkType: 'parent' | 'child';
    noteId: string;
    notebookId: string;
    title: string;
    sectionPath: string[];
    chunkIndex: number;
    content: string;
    parentId?: string;
}

interface EvalEntry {
    id: string;
    kind: 'chunk' | 'reindex' | 'search';
    description: string;
    markdown?: string;
    initialMarkdown?: string;
    updatedMarkdown?: string;
    /** 首次 reindex 时笔记标题（默认 '部署指南'；标题变更场景与 updatedTitle 区分以驱动就地重 embed） */
    initialTitle?: string;
    updatedTitle?: string;
    noteMissing?: boolean;
    invalidNoteId?: boolean;
    query?: string;
    searchParams?: { notebookId?: string; topK?: number };
    seedChunks?: SeedChunk[];
    expected?: ChunkExpected & SearchExpected;
    expectedFirst?: ReindexExpected;
    expectedAfterUpdate?: ReindexExpected;
}

// ── 常量 ──────────────────────────────────────────────────────

/** 评测用固定向量（4 维即可，仅用于让向量路返回候选，不追求语义正确） */
const EMB_VECTOR = [0.1, 0.2, 0.3, 0.4] as const;
const USER_ID = 'u1';
const NOTE_ID = '66f2c4f2a1b2c3d4e5f6a7b8';

// ── reindex fakeDB（内存模拟 NoteChunk 集合，跨两次 reindex 持久）──

interface FakeChunk {
    _id: mongoose.Types.ObjectId;
    chunkType: 'parent' | 'child';
    contentHash: string;
    parentId?: mongoose.Types.ObjectId | null;
    sectionPath: string[];
    /** 入库时的笔记标题（reindex diff 用它检测标题变更 → 就地重 embed） */
    title: string;
}

let fakeDb: FakeChunk[] = [];

/** 重置 fakeDB 并注入 NoteChunk / embedding 的 mock 实现（供 incrementalReindex 使用） */
function resetFakeDb(): void {
    fakeDb = [];

    (NoteChunk.find as any).mockImplementation(() => ({
        select: () => ({
            lean: () =>
                Promise.resolve(
                    fakeDb.map((c) => ({
                        _id: c._id,
                        chunkType: c.chunkType,
                        contentHash: c.contentHash,
                        parentId: c.parentId,
                        sectionPath: c.sectionPath,
                        title: c.title,
                    })),
                ),
        }),
    }));

    (NoteChunk.insertMany as any).mockImplementation(async (docs: any[]) => {
        fakeDb.push(
            ...docs.map((d: any) => ({
                _id: d._id,
                chunkType: d.chunkType,
                contentHash: d.contentHash,
                parentId: d.parentId,
                sectionPath: d.sectionPath,
                title: d.title,
            })),
        );
        return docs;
    });

    (NoteChunk.bulkWrite as any).mockImplementation(async (ops: any[]) => {
        let insertedCount = 0;
        for (const op of ops) {
            if (op.insertOne) {
                const d = op.insertOne.document;
                fakeDb.push({
                    _id: new mongoose.Types.ObjectId(),
                    chunkType: d.chunkType,
                    contentHash: d.contentHash,
                    parentId: d.parentId,
                    sectionPath: d.sectionPath,
                    title: d.title,
                });
                insertedCount++;
            } else if (op.updateOne) {
                const rec = fakeDb.find((c) =>
                    c._id.equals(op.updateOne.filter._id),
                );
                if (rec) {
                    const set = op.updateOne.update.$set;
                    rec.parentId = set.parentId;
                    rec.sectionPath = set.sectionPath;
                    if (set.title !== undefined) rec.title = set.title;
                }
            }
        }
        return { insertedCount, modifiedCount: 0 } as any;
    });

    (NoteChunk.deleteMany as any).mockImplementation(async (filter: any) => {
        const ids = (filter._id?.$in ?? []).map((x: any) => x.toString());
        const before = fakeDb.length;
        fakeDb = fakeDb.filter((c) => !ids.includes(c._id.toString()));
        return { deletedCount: before - fakeDb.length } as any;
    });

    (NoteChunk.updateMany as any).mockResolvedValue({
        modifiedCount: 0,
    });

    (generateEmbeddings as any).mockImplementation(async (input: string[]) => ({
        embeddings: input.map(() => [...EMB_VECTOR]),
        totalTokens: input.reduce(
            (sum: number, text: string) => sum + countTokens(text),
            0,
        ),
    }));
}

/** mock NoteModel.findOne(...).select(...) 返回指定内容（null 表示笔记不存在） */
function mockNoteContent(content: string | null, title = '部署指南'): void {
    const doc = content
        ? {
              _id: new mongoose.Types.ObjectId(),
              notebookId: new mongoose.Types.ObjectId(),
              createUser: USER_ID,
              title,
              content,
          }
        : null;
    vi.mocked(NoteModel.findOne).mockReturnValue({
        select: () => Promise.resolve(doc),
    } as any);
}

/** 强断言 ReindexResult 与 golden expected 的每个字段 */
function assertReindexExpected(
    result: ReindexResult,
    exp: ReindexExpected,
): void {
    expect(result.parentsInserted).toBe(exp.parentsInserted ?? 0);
    expect(result.parentsDeleted).toBe(exp.parentsDeleted ?? 0);
    expect(result.childrenInserted).toBe(exp.childrenInserted ?? 0);
    expect(result.childrenDeleted).toBe(exp.childrenDeleted ?? 0);
    expect(result.childrenReParented).toBe(exp.childrenReParented ?? 0);
    expect(result.unchanged).toBe(exp.unchanged ?? 0);
    if (exp.embeddingTokensGt !== undefined) {
        if (exp.embeddingTokensGt) {
            expect(result.embeddingTokens).toBeGreaterThan(0);
        } else {
            expect(result.embeddingTokens).toBe(0);
        }
    }
    if (exp.skipReason) expect(result.skipReason).toBe(exp.skipReason);
}

/** 剥离非确定性 durationMs 后返回可 snapshot 的对象 */
function stripDuration(
    result: ReindexResult,
): Omit<ReindexResult, 'durationMs'> {
    const { durationMs, ...rest } = result;
    expect(durationMs).toBeGreaterThanOrEqual(0);
    return rest;
}

// ── 数据驱动测试 ───────────────────────────────────────────────

describe.each(dataset as EvalEntry[])('Note RAG Eval', (entry) => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    // ── chunk：复用真实 chunkMarkdown，精确断言 + 整图 snapshot ──
    if (entry.kind === 'chunk') {
        it(`${entry.id}: ${entry.description}`, () => {
            const result = chunkMarkdown(entry.markdown!);
            const exp = entry.expected! as ChunkExpected;

            expect(result.parents.length).toBe(exp.parentCount);
            expect(result.children.length).toBe(exp.childCount);
            expect(result.parents.map((p) => p.sectionPath)).toEqual(
                exp.sectionPaths,
            );
            if (exp.childSectionPaths) {
                expect(result.children.map((c) => c.sectionPath)).toEqual(
                    exp.childSectionPaths,
                );
            }
            expect(result.stats.forcedSplitCount).toBe(exp.forcedSplitCount);

            // 结构单元保护：contains / notContains 对全部 child 内容校验
            const allChildContent = result.children
                .map((c) => c.content)
                .join('\n');
            for (const needle of exp.contains ?? []) {
                expect(allChildContent).toContain(needle);
            }
            for (const needle of exp.notContains ?? []) {
                expect(allChildContent).not.toContain(needle);
            }

            // 自审：contentHash 与独立 generateContentHash 交叉校验
            // D2：父块哈希=纯 content；child 哈希纳入章节路径（检索表示不含笔记标题）
            for (const p of result.parents) {
                expect(p.contentHash).toBe(generateContentHash(p.content));
            }
            for (const c of result.children) {
                expect(c.contentHash).toBe(
                    generateContentHash(
                        buildRetrievalText(c.sectionPath, c.content),
                    ),
                );
            }

            // 整图 snapshot（parents + children + stats 全为确定性字段）
            expect(result).toMatchSnapshot();
        });
    }

    // ── reindex：mock DB + embedding，跑两次 incrementalReindex ──
    if (entry.kind === 'reindex') {
        it(`${entry.id}: ${entry.description}`, async () => {
            const expAfter = entry.expectedAfterUpdate!;

            // 非法 noteId：前置校验直接短路，不触 DB
            if (entry.invalidNoteId) {
                const result = await incrementalReindex('not-a-valid-objectid');
                assertReindexExpected(result, expAfter);
                expect(stripDuration(result)).toMatchSnapshot();
                return;
            }

            resetFakeDb();

            // 笔记不存在：findOne 返回 null → skipReason，不落库
            if (entry.noteMissing) {
                mockNoteContent(null);
                const result = await incrementalReindex(NOTE_ID);
                assertReindexExpected(result, expAfter);
                expect(NoteChunk.find).not.toHaveBeenCalled();
                expect(stripDuration(result)).toMatchSnapshot();
                return;
            }

            // 首次全量 + 二次增量
            mockNoteContent(entry.initialMarkdown!, entry.initialTitle);
            const first = await incrementalReindex(NOTE_ID);
            assertReindexExpected(first, entry.expectedFirst!);
            expect(stripDuration(first)).toMatchSnapshot();

            // 清调用记录但保留 fakeDB 状态与 mock 实现 → 二次 reindex 基于首次落库结果
            vi.clearAllMocks();
            mockNoteContent(entry.updatedMarkdown!, entry.updatedTitle);
            const second = await incrementalReindex(NOTE_ID);
            assertReindexExpected(second, expAfter);
            expect(stripDuration(second)).toMatchSnapshot();

            // 自审：embedding / 落库 spy 调用次数与入参。
            // embedding 来源有二：① 新增 child（contentHash miss）；② 标题变更的已有 child 就地重 embed（reParentEmbed）
            const insertEmbed = (expAfter.childrenInserted ?? 0) > 0;
            const reParentEmbed = expAfter.reParentEmbed === true;
            if (insertEmbed || reParentEmbed) {
                expect(generateEmbeddings).toHaveBeenCalledTimes(1);
            } else {
                expect(generateEmbeddings).not.toHaveBeenCalled();
            }
            if ((expAfter.childrenReParented ?? 0) > 0) {
                const ops = (NoteChunk.bulkWrite as any).mock.calls[0]![0];
                const updateOps = ops.filter((op: any) => op.updateOne);
                expect(updateOps.length).toBe(expAfter.childrenReParented);
                // 就地更新 parentId + sectionPath + title，保留 _id 不新建。
                // 检索源未变（标题/章节/正文未变）的纯引用更新不触碰 embedding/searchText；
                // 标题变更场景（reParentEmbed）则就地重 embed，update ops 携带 embedding + searchText
                const titleAfter = entry.updatedTitle ?? '部署指南';
                for (const op of updateOps) {
                    const set = op.updateOne.update.$set;
                    expect(set.parentId).toBeInstanceOf(
                        mongoose.Types.ObjectId,
                    );
                    expect(Array.isArray(set.sectionPath)).toBe(true);
                    expect(set.title).toBe(titleAfter);
                    if (expAfter.reParentEmbed) {
                        expect(Array.isArray(set.embedding)).toBe(true);
                        expect(typeof set.searchText).toBe('string');
                        expect(set.searchText.length).toBeGreaterThan(0);
                    } else {
                        expect(set.embedding).toBeUndefined();
                        expect(set.searchText).toBeUndefined();
                    }
                }
            }
            if (
                (expAfter.childrenDeleted ?? 0) +
                    (expAfter.parentsDeleted ?? 0) >
                0
            ) {
                expect(NoteChunk.deleteMany).toHaveBeenCalled();
            }
        });
    }

    // ── search：mock embedding + NoteChunk，验证过滤与父子回填 ──
    if (entry.kind === 'search') {
        it(`${entry.id}: ${entry.description}`, async () => {
            const children = entry.seedChunks!.filter(
                (c) => c.chunkType === 'child',
            );
            const parents = entry.seedChunks!.filter(
                (c) => c.chunkType === 'parent',
            );

            vi.mocked(generateEmbedding).mockResolvedValue({
                totalTokens: 4,
                embeddings: [[...EMB_VECTOR]],
            });

            // aggregate mock：从管道里读出 notebookId 过滤条件，模拟 Mongo 过滤后返回 child 候选
            (NoteChunk.aggregate as any).mockImplementation(
                (pipeline: any[]) => {
                    let filterNotebookId: string | null = null;
                    const vectorFilter =
                        pipeline[0]?.$vectorSearch?.filter?.notebookId?.$eq;
                    if (vectorFilter) {
                        filterNotebookId = vectorFilter.toString();
                    }
                    const textMatch = pipeline[2]?.$match?.notebookId;
                    if (textMatch) {
                        filterNotebookId = textMatch.toString();
                    }
                    const candidates = filterNotebookId
                        ? children.filter(
                              (c) => c.notebookId === filterNotebookId,
                          )
                        : children;
                    return Promise.resolve(candidates);
                },
            );

            // find mock：返回命中 child 的 parentId 对应的 parent 全文（父子回填）
            (NoteChunk.find as any).mockImplementation((filter: any) => {
                const ids = (filter._id?.$in ?? []).map(String);
                const found = parents
                    .filter((p) => ids.includes(p._id))
                    .map((p) => ({ _id: p._id, content: p.content }));
                return {
                    select: () => ({
                        lean: () => Promise.resolve(found),
                    }),
                };
            });

            const results = await searchNotes({
                userId: USER_ID,
                query: entry.query!,
                notebookId: entry.searchParams?.notebookId,
                topK: entry.searchParams?.topK,
            });
            const exp = entry.expected! as SearchExpected;

            if (exp.resultsCount !== undefined) {
                expect(results.length).toBe(exp.resultsCount);
            }
            if (exp.allMatchNotebookId) {
                expect(
                    results.every(
                        (r) => r.notebookId === entry.searchParams!.notebookId,
                    ),
                ).toBe(true);
            }
            if (exp.topHasParentContext) {
                expect(results[0]).toBeDefined();
                expect(results[0]!.parentContext.length).toBeGreaterThan(0);
            }
            if (exp.parentContextContains) {
                expect(results[0]!.parentContext).toContain(
                    exp.parentContextContains,
                );
            }

            // 整结果 snapshot（score / 字段全为确定性）
            expect(results).toMatchSnapshot();

            // 自审：embedding 与双路检索 spy 调用次数/入参
            expect(generateEmbedding).toHaveBeenCalledTimes(1);
            expect(vi.mocked(generateEmbedding).mock.calls[0]![0]).toBe(
                entry.query!.trim(),
            );
            expect(NoteChunk.aggregate).toHaveBeenCalledTimes(2);
        });
    }
});

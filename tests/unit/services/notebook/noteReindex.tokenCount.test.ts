/**
 * M2：NoteChunk 落库的 tokenCount（单元测试）
 *
 * 验收标准：
 * - parent 块（RAG 注入单元）入库时带 tokenCount，且等于 countTokens(content)
 * - child 块只作检索键，不写 tokenCount
 * - parent 变更触发重切分时同样计入，不因 diff 复用而漏
 *
 * Mock 依赖：Note / NoteChunk（MongoDB）、generateEmbeddings、redis
 * 真实逻辑：chunkMarkdown 切分、parent diff、token 计数
 * 不连真实 MongoDB / Redis / embedding API，离线可跑。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

vi.mock('@/lib/redis', () => ({
    default: {
        sAdd: vi.fn(),
        sRem: vi.fn(),
        sMembers: vi.fn(),
        del: vi.fn(),
        incr: vi.fn(),
    },
}));

vi.mock('@/lib/embedding', () => ({
    generateEmbeddings: vi.fn(),
}));

vi.mock('@/models/Note', () => ({
    default: { findOne: vi.fn() },
}));

vi.mock('@/models/NoteChunk', () => ({
    NoteChunk: {
        find: vi.fn(),
        insertMany: vi.fn(),
        bulkWrite: vi.fn(),
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
        exists: vi.fn(),
    },
}));

// noteChunker / tokenizer 走真实实现（与 noteChunker.test.ts 约定一致），不 mock

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
import { generateEmbeddings } from '@/lib/embedding';
import NoteModel from '@/models/Note';
import { NoteChunk } from '@/models/NoteChunk';
import { countTokens } from '@/utils/tokenizer';

const mockedFindOne = vi.mocked(NoteModel.findOne);
const mockedFind = vi.mocked(NoteChunk.find);
const mockedInsertMany = vi.mocked(NoteChunk.insertMany);
const mockedChunkBulkWrite = vi.mocked(NoteChunk.bulkWrite);
const mockedDeleteMany = vi.mocked(NoteChunk.deleteMany);
const mockedExists = vi.mocked(NoteChunk.exists);

const NOTE_ID = new mongoose.Types.ObjectId().toHexString();

/** 追加到指定 token 数的中文正文（不依赖固定 token 数的字面量） */
function repeatToTokens(seed: string, targetTokens: number): string {
    let text = seed;
    while (countTokens(text) < targetTokens) text += seed;
    return text;
}

const NOTE_CONTENT =
    `## 安装说明\n\n${repeatToTokens('安装的详细步骤说明，请按照以下顺序操作。', 80)}\n\n` +
    `## 使用说明\n\n${repeatToTokens('使用的详细说明，涵盖常用命令与注意事项。', 80)}`;

function mockNote() {
    mockedFindOne.mockReturnValue({
        select: vi.fn().mockResolvedValue({
            _id: new mongoose.Types.ObjectId(),
            notebookId: new mongoose.Types.ObjectId(),
            createUser: 'u1',
            title: '笔记标题',
            content: NOTE_CONTENT,
        }),
    } as any);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockNote();
    // 无旧块 → 所有 parent / child 均为新增
    mockedFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
        }),
    } as any);
    mockedInsertMany.mockResolvedValue([] as any);
    mockedChunkBulkWrite.mockResolvedValue({ insertedCount: 2 } as any);
    mockedDeleteMany.mockResolvedValue({ deletedCount: 0 } as any);
    mockedExists.mockResolvedValue(false as any);
    vi.mocked(generateEmbeddings).mockImplementation(async (texts: string[]) => ({
        embeddings: texts.map(() => [0.1, 0.2]),
        totalTokens: 0,
    }));
});

describe('NoteChunk tokenCount', () => {
    it('happy：parent 块带 tokenCount，等于 countTokens(parent content)', async () => {
        const result = await incrementalReindex(NOTE_ID);

        expect(result.parentsInserted).toBe(2);
        expect(mockedInsertMany).toHaveBeenCalledTimes(1);

        const docs = mockedInsertMany.mock.calls[0]![0] as any[];
        expect(docs).toHaveLength(2);
        for (const doc of docs) {
            expect(doc.chunkType).toBe('parent');
            expect(doc.tokenCount).toBe(countTokens(doc.content));
            expect(doc.tokenCount).toBeGreaterThan(0);
        }
        // 章节正文非空，计数必然为正（防断言退化成 0 === 0）
        expect(countTokens(docs[0]!.content)).toBeGreaterThan(50);
    });

    it('边界：child 块不写 tokenCount（仅检索键，不做注入单元）', async () => {
        await incrementalReindex(NOTE_ID);

        const ops = mockedChunkBulkWrite.mock.calls[0]![0] as any[];
        expect(ops.length).toBeGreaterThan(0);
        for (const op of ops) {
            const doc = op.insertOne.document;
            expect(doc.chunkType).toBe('child');
            expect('tokenCount' in doc).toBe(false);
        }
    });

    it('边界：parent 全部复用（无新增）时不产生 insertMany 调用', async () => {
        // 旧块与本次切分结果一致 → parent diff 为空
        const { chunkMarkdown } = await import('@/utils/noteChunker');
        const { parents } = chunkMarkdown(NOTE_CONTENT);
        mockedFind.mockReturnValue({
            select: vi.fn().mockReturnValue({
                lean: vi.fn().mockResolvedValue(
                    parents.map((p, i) => ({
                        _id: new mongoose.Types.ObjectId(),
                        chunkType: 'parent',
                        contentHash: p.contentHash,
                        parentId: null,
                        sectionPath: p.sectionPath,
                        title: p.title,
                        chunkIndex: i,
                    })),
                ),
            }),
        } as any);

        const result = await incrementalReindex(NOTE_ID);

        expect(result.parentsInserted).toBe(0);
        expect(mockedInsertMany).not.toHaveBeenCalled();
    });
});

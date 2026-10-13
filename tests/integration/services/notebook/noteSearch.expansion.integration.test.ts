/**
 * noteSearch query-expansion 集成测试
 *
 * 真实 MongoDB（TEST_MONGO_URI），Mock Embedding API / Redis / Logger
 * 验证：口语化 query 经 expandQuery 展开后，扩展串同时进入向量输入与 BM25 输入，
 *       从而召回「正文只含领域术语、不含口语词」的 chunk；与术语 / 同义词均无交集的
 *       query 则不会召回该 chunk（证明召回确由 expansion 桥接，而非本就匹配）。
 *
 * 运行前提：TEST_MONGO_URI 指向可连的 MongoDB（默认本地 mnemo_test）。
 * 本仓库无本地 mongod，实际执行须显式指到云集群的独立测试库：
 *   TEST_MONGO_URI='<MONGODB_URI 的 host>/mnemo_test?<原参数>' npx vitest run \
 *     tests/integration/services/notebook/noteSearch.expansion.integration.test.ts
 * 运行命令：pnpm test:integration
 *
 * 注意：真实写数据到测试库，用例前后自动清理（仅清理本用例 userId）。
 */

// ── Mock 外部依赖（hoisted，先于被测模块注入）──

/**
 * 确定性伪向量：按字符编码铺满 1536 维（与 memorySearch 集成测同口径）。
 * 仅用于「向量路跑通 + 传入串可断言」，不承载语义相似度。
 */
const { mockGenerateEmbedding, makeDeterministicEmbedding } = vi.hoisted(() => {
    const makeDeterministicEmbedding = (text: string): number[] =>
        Array.from({ length: 1536 }, (_, i) =>
            i < text.length ? text.charCodeAt(i) / 65536 : 0,
        );
    return {
        makeDeterministicEmbedding,
        mockGenerateEmbedding: vi.fn(async (text: string) => ({
            totalTokens: text.length,
            embeddings: [makeDeterministicEmbedding(text)],
        })),
    };
});

vi.mock('@/lib/embedding', () => ({
    generateEmbedding: mockGenerateEmbedding,
}));

// redisClient 在模块导入时即 connect()，集成测试须 mock 掉避免真实连接
vi.mock('@/lib/redis', () => ({
    default: {
        sAdd: vi.fn(),
        sRem: vi.fn(),
        del: vi.fn(),
        incr: vi.fn(),
        sMembers: vi.fn(async () => []),
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

// ── 正式导入（Mock 已注入）──
import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    beforeEach,
    vi,
} from 'vitest';
import mongoose from 'mongoose';
import { NoteChunk } from '@/models/NoteChunk';
import { buildRetrievalText } from '@/utils/noteChunker';
import { tokenize } from '@/utils/tokenizer';
import { expandQuery } from '@/utils/queryExpansion';
import { searchNotes } from '@/services/notebook/noteSearch.service';

const TEST_MONGO_URI =
    process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/mnemo_test';

const USER_ID = 'int-note-search-expansion:user';
const OTHER_USER_ID = 'int-note-search-expansion:other';
const NOTEBOOK_ID = new mongoose.Types.ObjectId();
const NOTE_ID = new mongoose.Types.ObjectId();

/** 口语化 query（数据集 q_l2_para 原句）：其分词结果与目标 chunk 完全无交集 */
const ORAL_QUERY = '用户很久没说话，系统怎么自动把对话内容存成长期记忆';

/** 与目标术语、同义词表均无交集的 query（用于反向断言） */
const UNRELATED_QUERY = '二分查找的前提条件是什么';

/** 目标 chunk 正文：只含领域术语（L2 超时触发），不含口语词 */
const TARGET_CONTENT =
    'L2 超时触发：周期性扫描 last_active_at 空闲时长，超过阈值即收尾并写入终态。';
const TARGET_TITLE = '工程速记';
const TARGET_SECTION = ['术语备忘'];
const PARENT_CONTENT = `## 术语备忘\n\n${TARGET_CONTENT}`;

/** 干扰块正文：与反向断言 query 高度同构（向量路兜底时也压住目标块的排名） */
const DISTRACTOR_CONTENT = `${UNRELATED_QUERY}，需要先满足有序与可随机访问两个前提。`;
const DISTRACTOR_COUNT = 5;

/** 与 noteReindex 入库口径一致的检索表示（标题 + 章节路径 + 正文）→ 分词 */
function toSearchText(title: string, sectionPath: string[], content: string) {
    return tokenize(buildRetrievalText([title, ...sectionPath], content));
}

interface SeedResult {
    targetChunkId: string;
    otherUserChunkId: string;
}

async function seedCorpus(): Promise<SeedResult> {
    const parentId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();

    await NoteChunk.insertMany([
        // 目标块的 parent（仅用于父子回填断言）
        {
            _id: parentId,
            noteId: NOTE_ID,
            notebookId: NOTEBOOK_ID,
            userId: USER_ID,
            title: TARGET_TITLE,
            chunkType: 'parent' as const,
            sectionPath: TARGET_SECTION,
            chunkIndex: 0,
            content: PARENT_CONTENT,
            searchText: toSearchText(
                TARGET_TITLE,
                TARGET_SECTION,
                PARENT_CONTENT,
            ),
            contentHash: 'hash-parent-expansion',
            tokenCount: 32,
        },
        // 目标 child：正文只含领域术语，口语 query 分词后与其零交集
        {
            _id: targetId,
            noteId: NOTE_ID,
            notebookId: NOTEBOOK_ID,
            userId: USER_ID,
            title: TARGET_TITLE,
            chunkType: 'child' as const,
            parentId,
            sectionPath: TARGET_SECTION,
            chunkIndex: 0,
            content: TARGET_CONTENT,
            searchText: toSearchText(
                TARGET_TITLE,
                TARGET_SECTION,
                TARGET_CONTENT,
            ),
            embedding: makeDeterministicEmbedding(TARGET_CONTENT),
            contentHash: 'hash-child-expansion',
        },
        // 干扰 child：与目标术语 / 展开词无交集
        ...Array.from({ length: DISTRACTOR_COUNT }, (_, i) => ({
            noteId: NOTE_ID,
            notebookId: NOTEBOOK_ID,
            userId: USER_ID,
            title: '杂记',
            chunkType: 'child' as const,
            parentId: null,
            sectionPath: ['无关'],
            chunkIndex: i + 1,
            content: DISTRACTOR_CONTENT,
            searchText: toSearchText('杂记', ['无关'], DISTRACTOR_CONTENT),
            embedding: makeDeterministicEmbedding(DISTRACTOR_CONTENT),
            contentHash: `hash-distractor-${i}`,
        })),
        // 他人数据：验证 userId 隔离，展开后也不得跨用户召回
        {
            _id: otherUserId,
            noteId: NOTE_ID,
            notebookId: NOTEBOOK_ID,
            userId: OTHER_USER_ID,
            title: TARGET_TITLE,
            chunkType: 'child' as const,
            parentId: null,
            sectionPath: TARGET_SECTION,
            chunkIndex: 100,
            content: TARGET_CONTENT,
            searchText: toSearchText(
                TARGET_TITLE,
                TARGET_SECTION,
                TARGET_CONTENT,
            ),
            embedding: makeDeterministicEmbedding(TARGET_CONTENT),
            contentHash: 'hash-other-user-expansion',
        },
    ]);

    return {
        targetChunkId: targetId.toString(),
        otherUserChunkId: otherUserId.toString(),
    };
}

async function cleanup(): Promise<void> {
    await NoteChunk.deleteMany({ userId: { $in: [USER_ID, OTHER_USER_ID] } });
}

beforeAll(async () => {
    await mongoose.connect(TEST_MONGO_URI);
    // autoIndex 全局关闭：BM25 路依赖 text index，需显式建索引
    await NoteChunk.createIndexes();
});

afterAll(async () => {
    await cleanup();
    await mongoose.disconnect();
});

beforeEach(async () => {
    await cleanup();
    mockGenerateEmbedding.mockClear();
});

describe('searchNotes query-expansion', () => {
    it('INT1 - 口语 query 经展开后召回「术语-only」chunk，且扩展串进入向量输入', async () => {
        const { targetChunkId, otherUserChunkId } = await seedCorpus();

        const results = await searchNotes({
            userId: USER_ID,
            query: ORAL_QUERY,
            topK: 5,
        });

        // 目标块被召回（父块回填同期生效）
        const hit = results.find((r) => r.chunkId === targetChunkId);
        expect(hit).toBeDefined();
        expect(hit?.content).toBe(TARGET_CONTENT);
        expect(hit?.parentContext).toBe(PARENT_CONTENT);

        // 扩展串（同义词表产物）确实传给了向量路，而非仅传给 BM25
        const expanded = expandQuery(ORAL_QUERY);
        expect(expanded).not.toBe(ORAL_QUERY);
        expect(mockGenerateEmbedding).toHaveBeenCalledWith(expanded);
        expect(mockGenerateEmbedding).toHaveBeenCalledWith(
            expect.stringContaining('超时触发'),
        );

        // 跨用户隔离：他人 userId 的同内容块不得出现（即使展开词与该块正文一致）
        expect(results.some((r) => r.chunkId === otherUserChunkId)).toBe(false);
    });

    it('INT2 - 与术语及同义词均无交集的 query 不召回该 chunk', async () => {
        const { targetChunkId } = await seedCorpus();

        const results = await searchNotes({
            userId: USER_ID,
            query: UNRELATED_QUERY,
            topK: 5,
        });

        // 未展开（原样传给向量路），且不召回目标块
        expect(expandQuery(UNRELATED_QUERY)).toBe(UNRELATED_QUERY);
        expect(mockGenerateEmbedding).toHaveBeenCalledWith(UNRELATED_QUERY);
        // 非空洞负例：干扰块确实被召回（证明检索链路有效），只是目标块不在其中
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((r) => r.content === DISTRACTOR_CONTENT)).toBe(
            true,
        );
        expect(results.some((r) => r.chunkId === targetChunkId)).toBe(false);
    });

    it('INT3 - 桥接自审：原 query 与目标块 searchText 零词交集，命中共现词只在展开后出现', async () => {
        await seedCorpus();

        const target = await NoteChunk.findOne({
            userId: USER_ID,
            content: TARGET_CONTENT,
        })
            .select('searchText')
            .lean<{ searchText: string } | null>();
        expect(target).not.toBeNull();

        /** 取有效词（滤掉纯标点 token，否则「，」这类空 token 会伪造成交集） */
        const termsOf = (text: string) =>
            new Set(text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)));

        // searchText 入库时已是分词结果，直接按空白切（与 $text 的匹配单元一致）
        const chunkTerms = termsOf(target!.searchText);
        const rawOverlap = [...termsOf(tokenize(ORAL_QUERY))].filter((t) =>
            chunkTerms.has(t),
        );
        const expandedOverlap = [
            ...termsOf(tokenize(expandQuery(ORAL_QUERY))),
        ].filter((t) => chunkTerms.has(t));

        // 未展开时零交集（BM25 无从匹配）→ 展开后产生交集（BM25 得以命中）
        expect(rawOverlap).toEqual([]);
        expect(expandedOverlap).toContain('超时');
        expect(expandedOverlap).toContain('L2');
        expect(expandedOverlap).toContain('触发');
    });
});

/**
 * incrementalReindex force 行为集成测试
 *
 * 真实 MongoDB，Mock Embedding API / Redis / Logger
 * 验证：force=true 绕过 contentHash diff 无条件重切 searchText（用当前分词器）
 *       + 重 embed；force=false 且 contentHash 未变时跳过重建（原增量行为不回归）。
 *
 * 运行前提：TEST_MONGO_URI 指向可连的 MongoDB（默认本地 mnemo_test）
 * 运行命令：pnpm test:integration
 *
 * 注意：真实写数据到测试库，用例前后自动清理（仅清理本用例 userId）。
 */

// ── Mock 外部依赖（hoisted，先于被测模块注入）──

const mockGenerateEmbeddings = vi.hoisted(() =>
    vi.fn(async (input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        const embeddings = texts.map(
            (t, i) => [t.length, i, 0.1, 0.2] as number[],
        );
        return { embeddings, totalTokens: texts.length * 10 };
    }),
);

vi.mock('@/lib/embedding', () => ({
    generateEmbeddings: mockGenerateEmbeddings,
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
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import NoteModel from '@/models/Note';
import { NoteChunk } from '@/models/NoteChunk';
import { chunkMarkdown, buildRetrievalText } from '@/utils/noteChunker';
import { tokenize } from '@/utils/tokenizer';
import { incrementalReindex } from '@/services/notebook/noteReindex.service';

const TEST_MONGO_URI =
    process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/mnemo_test';

const USER_ID = 'int-reindex-force:user';
const NOTEBOOK_ID = new mongoose.Types.ObjectId();

/** 模拟「旧词典切分」的 searchText（'乐观锁' 被切碎成 '乐观 锁'） */
const STALE_SEARCH_TEXT = '旧 词典 乐观 锁 占位';

const NOTE_CONTENT = [
    '## 乐观锁机制',
    '',
    '乐观锁通过版本号比对来避免并发写冲突，更新时若版本号不符则说明数据已被他人修改，',
    '此时更新失败并交由上层重试，因此乐观锁适合读多写少的场景，冲突代价低于加锁等待，',
    '常用于库存扣减、状态机流转等需要防止覆盖写的高并发路径。',
    '',
    '## 消费者组',
    '',
    '消费者组用于并行消费同一主题下的分区消息，组内每个分区同一时刻只由一名消费者处理，',
    '从而在保证分区内顺序的前提下实现水平扩展，消费者上下线会触发分区再均衡，',
    '再均衡期间该组会短暂停止消费，因此需要关注会话超时与心跳间隔的配置。',
].join('\n');

interface SeededNote {
    noteId: string;
    childCount: number;
}

async function seedNote(): Promise<SeededNote> {
    const note = await NoteModel.create({
        notebookId: NOTEBOOK_ID,
        title: '并发控制笔记',
        content: NOTE_CONTENT,
        createUser: USER_ID,
        updateUser: USER_ID,
    });

    const { parents, children } = chunkMarkdown(NOTE_CONTENT);
    // parentId 按 parentIndex 映射（与 incrementalReindex 入库逻辑一致）
    const parentIds = parents.map(() => new mongoose.Types.ObjectId());

    await NoteChunk.insertMany([
        ...parents.map((p, i) => ({
            _id: parentIds[i],
            noteId: note._id,
            notebookId: NOTEBOOK_ID,
            userId: USER_ID,
            title: note.title,
            chunkType: 'parent' as const,
            sectionPath: p.sectionPath,
            chunkIndex: p.chunkIndex,
            content: p.content,
            searchText: STALE_SEARCH_TEXT,
            contentHash: p.contentHash,
            tokenCount: 1,
        })),
        ...children.map((c) => ({
            noteId: note._id,
            notebookId: NOTEBOOK_ID,
            userId: USER_ID,
            title: note.title,
            chunkType: 'child' as const,
            parentId: parentIds[c.parentIndex],
            sectionPath: c.sectionPath,
            chunkIndex: c.chunkIndex,
            content: c.content,
            // 旧 searchText + 旧 embedding，模拟词典变更前的存量索引
            searchText: STALE_SEARCH_TEXT,
            embedding: [0.9, 0.9, 0.9, 0.9],
            contentHash: c.contentHash,
        })),
    ]);

    return { noteId: note._id.toString(), childCount: children.length };
}

async function cleanup(): Promise<void> {
    await NoteChunk.deleteMany({ userId: USER_ID });
    await NoteModel.deleteMany({ createUser: USER_ID });
}

beforeAll(async () => {
    await mongoose.connect(TEST_MONGO_URI);
});

afterAll(async () => {
    await cleanup();
    await mongoose.disconnect();
});

beforeEach(async () => {
    await cleanup();
    mockGenerateEmbeddings.mockClear();
});

describe('incrementalReindex({ force })', () => {
    it('INT1 - force=true 绕过 diff：searchText 用新词典重切 + embedding 重生成', async () => {
        const { noteId, childCount } = await seedNote();

        const result = await incrementalReindex(noteId, { force: true });

        // 无条件重建：无「复用」分支，且触发了 re-embed
        expect(result.unchanged).toBe(0);
        expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);

        const children = await NoteChunk.find({
            noteId,
            chunkType: 'child',
        }).lean<
            Array<{
                content: string;
                searchText: string;
                sectionPath: string[];
            }>
        >();
        expect(children.length).toBe(childCount);

        // 存量 searchText 被替换：不再是旧切分的哨兵值，而等于当前分词器对检索表示的重切结果
        // （断言不依赖具体词典内容——M1 领域词典已证伪置空，此后仍须保证 force 用「当前」分词器）
        expect(children.every((c) => c.searchText !== STALE_SEARCH_TEXT)).toBe(
            true,
        );
        for (const child of children) {
            const expected = tokenize(
                buildRetrievalText(
                    ['并发控制笔记', ...child.sectionPath],
                    child.content,
                ),
            );
            expect(child.searchText).toBe(expected);
        }
    });

    it('INT2 - force 缺省（false）且 contentHash 未变：跳过重建，保留存量 searchText', async () => {
        const { noteId, childCount } = await seedNote();

        const result = await incrementalReindex(noteId);

        // 原增量行为不回归：全部判定为 unchanged，未烧 embedding
        expect(result.unchanged).toBe(childCount);
        expect(result.childrenInserted).toBe(0);
        expect(result.childrenReParented).toBe(0);
        expect(mockGenerateEmbeddings).not.toHaveBeenCalled();

        const children = await NoteChunk.find({
            noteId,
            chunkType: 'child',
        }).lean<Array<{ searchText: string }>>();
        expect(children.every((c) => c.searchText === STALE_SEARCH_TEXT)).toBe(
            true,
        );
    });

    it('INT3 - 非法 noteId：force=true 也不抛错，返回 INVALID_ID 跳过原因', async () => {
        const result = await incrementalReindex('not-an-objectid', {
            force: true,
        });
        expect(result.skipReason).toBe('INVALID_ID');
        expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
    });
});

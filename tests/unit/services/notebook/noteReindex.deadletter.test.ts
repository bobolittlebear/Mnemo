/**
 * noteReindex.service.ts 死信（dead-letter）链路单元测试
 *
 * 目标：锁死「embedding 连续失败 → failCount 递增 → 超过 MAX_FAILS → 移入
 *       note:reindex:dead 停止重试」链路，并验证死信路径会移出 pending 停止重试、
 *       中途恢复（失败后成功）会清理计数并消费 pending。
 *
 * 死信逻辑在未导出的 processOne（worker 内部），incrementalReindex 本身不碰 Redis，
 * 故通过已导出的 startNoteReindexWorker 驱动真实 worker 链路复现多轮失败计数：
 *   - mongoose.connection.readyState 置为 connected，绕过 pollOnce 的未就绪守卫
 *   - redis.sMembers 返回同一 noteId 多次，单轮 worker 对同一 note 串行重试
 *   - generateEmbeddings 默认恒抛 → incrementalReindex reject → processOne 走失败分支；
 *     recovery 用例用 mockRejectedValueOnce × MAX_FAILS + mockResolvedValue 构造
 *     「前 MAX_FAILS 次失败、第 MAX_FAILS+1 次成功」序列
 *
 * 不连真实 MongoDB / Redis / embedding API，离线可跑。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// noteChunker / incrementalReindex 用真实 tokenizer（与 noteChunker.test.ts 约定一致），不 mock

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// ── 引入被测模块（在 Mock 之后）──

import {
    startNoteReindexWorker,
    stopNoteReindexWorker,
    MAX_FAILS,
    PENDING_KEY,
    DEAD_KEY,
    FAIL_KEY_PREFIX,
} from '@/services/notebook/noteReindex.service';
import { generateEmbeddings } from '@/lib/embedding';
import redisClient from '@/lib/redis';
import NoteModel from '@/models/Note';
import { NoteChunk } from '@/models/NoteChunk';

// ── 常量（队列 Key / 重试上限从源码导入，避免字面量耦合）──

const NOTE_ID = '66f2c4f2a1b2c3d4e5f6a7b8';
/** 会产出 parent + child 的真实 markdown，确保每次 reindex 都走到 embedding */
const NOTE_MD = '# 标题\n\n正文段落内容。';

// ── fakeDB（内存模拟 NoteChunk 集合，跨多轮重试持久）──

interface FakeChunk {
    _id: mongoose.Types.ObjectId;
    chunkType: 'parent' | 'child';
    contentHash: string;
    parentId?: mongoose.Types.ObjectId | null;
    sectionPath: string[];
}

let fakeDb: FakeChunk[] = [];

/** beforeEach 统一注入：fakeDB 重置 + Note/NoteChunk/embedding/redis mock 实现 */
function setupMocks(): void {
    fakeDb = [];

    // 自引用链式 mock：select / sort / lean 均返回同一对象，兼容未来查询链追加环节
    const chunkQuery = {
        select: () => chunkQuery,
        sort: () => chunkQuery,
        lean: () =>
            Promise.resolve(
                fakeDb.map((c) => ({
                    _id: c._id,
                    chunkType: c.chunkType,
                    contentHash: c.contentHash,
                    parentId: c.parentId,
                    sectionPath: c.sectionPath,
                })),
            ),
    };
    (NoteChunk.find as any).mockReturnValue(chunkQuery);
    (NoteChunk.insertMany as any).mockImplementation(async (docs: any[]) => {
        fakeDb.push(
            ...docs.map((d: any) => ({
                _id: d._id,
                chunkType: d.chunkType,
                contentHash: d.contentHash,
                parentId: d.parentId,
                sectionPath: d.sectionPath,
            })),
        );
        return docs;
    });
    (NoteChunk.bulkWrite as any).mockResolvedValue({
        insertedCount: 0,
        modifiedCount: 0,
    });
    (NoteChunk.deleteMany as any).mockResolvedValue({ deletedCount: 0 });
    (NoteChunk.updateMany as any).mockResolvedValue({ modifiedCount: 0 });
    (NoteChunk.exists as any).mockResolvedValue(null);

    const noteDoc = {
        _id: new mongoose.Types.ObjectId(),
        notebookId: new mongoose.Types.ObjectId(),
        createUser: 'u1',
        title: '标题',
        content: NOTE_MD,
    };
    vi.mocked(NoteModel.findOne).mockReturnValue({
        select: () => Promise.resolve(noteDoc),
    } as any);

    // embedding 默认永久故障：每次 reindex 走到向量化都抛（recovery 用例会覆盖为「前 N 次失败+成功」）
    vi.mocked(generateEmbeddings).mockRejectedValue(
        new Error('embedding 永久故障'),
    );

    // redis.incr 保持跨多次调用的递增状态（模拟真实 Redis INCR）
    const failCounts = new Map<string, number>();
    (redisClient.incr as any).mockImplementation((key: string) => {
        const next = (failCounts.get(key) ?? 0) + 1;
        failCounts.set(key, next);
        return Promise.resolve(next);
    });
}

describe('noteReindex 死信链路（worker 驱动）', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        setupMocks();
        // 绕过 pollOnce 的「MongoDB 未就绪」守卫。直接改内部态仅为测试便捷；
        // 若 mongoose 升级为 getter-only，需改 vi.spyOn(mongoose.connection, 'readyState').mockReturnValue(1)
        (mongoose.connection as any).readyState = 1;
    });

    afterEach(() => {
        stopNoteReindexWorker();
        (mongoose.connection as any).readyState = 0;
    });

    it('failure path：连续失败 1~MAX_FAILS 次仅递增计数，不触发死信，不消费 pending', async () => {
        // 用重复成员模拟同一 note 的 N 次 processOne：死信判定只依赖 failCount（按 noteId 独立计数），
        // 与轮次结构无关。真实 Redis SET 天然去重，此处为驱动计数器的测试技巧
        vi.mocked(redisClient.sMembers).mockResolvedValue(
            Array(MAX_FAILS).fill(NOTE_ID),
        );

        // 测试依赖源码 startNoteReindexWorker 立即同步触发首轮 pollOnce（void pollOnce）的实现细节；
        // 若未来改为不立即首轮，需改用 vi.useFakeTimers 推进时间
        startNoteReindexWorker(60000);

        await vi.waitFor(() => {
            expect(redisClient.incr).toHaveBeenCalledTimes(MAX_FAILS);
        });

        // failCount 1~MAX_FAILS ≤ MAX_FAILS：不 sAdd 死信
        expect(redisClient.sAdd).not.toHaveBeenCalled();
        // 失败计数键正确：note:reindex:fail:{noteId}
        expect(redisClient.incr).toHaveBeenCalledWith(
            `${FAIL_KEY_PREFIX}${NOTE_ID}`,
        );
        // worker 从 pending 队列读取该 note
        expect(redisClient.sMembers).toHaveBeenCalledWith(PENDING_KEY);
        // 未达死信阈值：源码 catch 后直接 return，不消费 pending / 不清理失败计数
        expect(redisClient.sRem).not.toHaveBeenCalled();
        expect(redisClient.del).not.toHaveBeenCalled();
        // 每次 reindex 都走到 embedding 并抛错
        expect(generateEmbeddings).toHaveBeenCalledTimes(MAX_FAILS);
    });

    it('dead-letter path：第 MAX_FAILS+1 次失败移入死信、移出 pending 并停止重试', async () => {
        // 同 failure path：重复成员驱动同一 note 的 N 次串行 processOne
        vi.mocked(redisClient.sMembers).mockResolvedValue(
            Array(MAX_FAILS + 1).fill(NOTE_ID),
        );

        // 依赖立即首轮 pollOnce 的实现细节，同 failure path 注释
        startNoteReindexWorker(60000);

        // sAdd(DEAD_KEY) 只可能在第 MAX_FAILS+1 次失败后触发，兼作 worker 一轮跑完的信号
        await vi.waitFor(() => {
            expect(redisClient.sAdd).toHaveBeenCalledTimes(1);
        });

        // 第 MAX_FAILS+1 次失败移入死信
        expect(redisClient.sAdd).toHaveBeenCalledWith(DEAD_KEY, NOTE_ID);
        expect(redisClient.sAdd).toHaveBeenCalledTimes(1);
        // failCount 严格递增到 MAX_FAILS+1（前 MAX_FAILS 次各进死信的话 sAdd 会 >1）
        expect(redisClient.incr).toHaveBeenCalledTimes(MAX_FAILS + 1);
        expect(redisClient.incr).toHaveBeenCalledWith(
            `${FAIL_KEY_PREFIX}${NOTE_ID}`,
        );
        // 死信语义：移出 pending 停止重试，并清理失败计数键（S1 修复后不再每轮白烧 embedding）
        expect(redisClient.sRem).toHaveBeenCalledWith(PENDING_KEY, NOTE_ID);
        expect(redisClient.del).toHaveBeenCalledWith(
            `${FAIL_KEY_PREFIX}${NOTE_ID}`,
        );
        expect(generateEmbeddings).toHaveBeenCalledTimes(MAX_FAILS + 1);
    });

    it('recovery path：前 MAX_FAILS 次失败、第 MAX_FAILS+1 次成功应清理计数并消费 pending', async () => {
        // 前 MAX_FAILS 次走到 embedding 抛错，第 MAX_FAILS+1 次回落成功：
        // mockResolvedValue 设默认成功，mockRejectedValueOnce × MAX_FAILS 压入前 N 次失败
        // （once 实现优先于默认实现，消耗完后回落到默认成功）
        vi.mocked(generateEmbeddings).mockResolvedValue({
            embeddings: [new Array(1536).fill(0)],
            totalTokens: 10,
        });
        for (let i = 0; i < MAX_FAILS; i++) {
            vi.mocked(generateEmbeddings).mockRejectedValueOnce(
                new Error('embedding 永久故障'),
            );
        }

        // 同 failure path：重复成员驱动同一 note 的 N 次串行 processOne
        vi.mocked(redisClient.sMembers).mockResolvedValue(
            Array(MAX_FAILS + 1).fill(NOTE_ID),
        );

        // 依赖立即首轮 pollOnce 的实现细节，同 failure path 注释
        startNoteReindexWorker(60000);

        // 第 MAX_FAILS+1 次成功 → 成功分支 sRem 消费 pending，兼作 worker 一轮跑完的信号
        await vi.waitFor(() => {
            expect(redisClient.sRem).toHaveBeenCalledTimes(1);
        });

        // 前 MAX_FAILS 次失败未达死信阈值（死信在「第 MAX_FAILS+1 次失败」才触发）：不进死信
        expect(redisClient.sAdd).not.toHaveBeenCalled();
        // 成功分支：sRem 消费 pending + del 清理失败计数
        expect(redisClient.sRem).toHaveBeenCalledWith(PENDING_KEY, NOTE_ID);
        expect(redisClient.del).toHaveBeenCalledWith(
            `${FAIL_KEY_PREFIX}${NOTE_ID}`,
        );
        // 前 MAX_FAILS 次失败 + 最后一次成功，共 MAX_FAILS+1 次 embedding 调用
        expect(generateEmbeddings).toHaveBeenCalledTimes(MAX_FAILS + 1);
        // 失败计数仅递增到 MAX_FAILS（第 MAX_FAILS+1 次成功走成功分支，不 incr）
        expect(redisClient.incr).toHaveBeenCalledTimes(MAX_FAILS);
    });
});

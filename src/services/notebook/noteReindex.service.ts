// src/services/notebook/noteReindex.service.ts
// 笔记 RAG 增量重建：contentHash diff 只重建变化 chunk + Redis 脏标记队列单 worker。
//
// 职责边界：
// - incrementalReindex(noteId)：增量重建（纯数据层，供 worker 调用）
// - startNoteReindexWorker()：后台单 worker，消费 note:reindex:pending 队列
// - markNoteDirty / removeNoteIndex：note.service 的增删改 hook 调用（fire-and-forget）
//
// 派生数据 NoteChunk 一律物理删除（不软删），源 Note 仍走软删除。
import mongoose from 'mongoose';
import { NoteChunk } from '@/models/NoteChunk';
import NoteModel from '@/models/Note';
import { chunkMarkdown } from '@/utils/noteChunker';
import type { ChildChunk } from '@/types/noteChunk';
import { generateEmbeddings } from '@/lib/embedding';
import { tokenize } from '@/utils/tokenizer';
import redisClient from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import { withRetry } from '@/lib/retry';

const log = createLogger('rag');

/* ------------------------------------------------------------------ */
/* Redis 脏标记队列 Key                                                */
/* ------------------------------------------------------------------ */

const PENDING_KEY = 'note:reindex:pending'; // Set：待重建的 noteId
const DEAD_KEY = 'note:reindex:dead'; // Set：连续失败移入的死信 noteId
const FAIL_KEY_PREFIX = 'note:reindex:fail:'; // 计数：note:reindex:fail:{noteId}

/** 单条笔记 reindex 失败重试上限，超过进入死信（防 embedding 永久失败死循环） */
const MAX_FAILS = 3;
/** worker 轮询间隔（ms）。用递归 setTimeout 而非 setInterval，天然避免重叠执行 */
const POLL_INTERVAL_MS = 20000;

/* ------------------------------------------------------------------ */
/* 对外类型                                                            */
/* ------------------------------------------------------------------ */

export interface ReindexResult {
    noteId: string;
    parentsInserted: number;
    parentsDeleted: number;
    childrenInserted: number;
    childrenReParented: number;
    childrenDeleted: number;
    unchanged: number;
    embeddingTokens: number;
    durationMs: number;
    /** 未实际重建的原因（笔记不存在 / noteId 非法） */
    skipReason?: string;
}

interface LeanChunk {
    _id: mongoose.Types.ObjectId;
    chunkType: 'parent' | 'child';
    contentHash: string;
    parentId?: mongoose.Types.ObjectId | null;
    sectionPath: string[];
}

/* ------------------------------------------------------------------ */
/* 增量重建                                                            */
/* ------------------------------------------------------------------ */

function buildEmptyResult(noteId: string, skipReason?: string): ReindexResult {
    return {
        noteId,
        parentsInserted: 0,
        parentsDeleted: 0,
        childrenInserted: 0,
        childrenReParented: 0,
        childrenDeleted: 0,
        unchanged: 0,
        embeddingTokens: 0,
        durationMs: 0,
        ...(skipReason ? { skipReason } : {}),
    };
}

export async function incrementalReindex(
    noteId: string,
): Promise<ReindexResult> {
    const start = Date.now();

    if (!mongoose.Types.ObjectId.isValid(noteId)) {
        log.warn('reindex 跳过：noteId 非法', { noteId });
        return buildEmptyResult(noteId, 'INVALID_ID');
    }

    const note = await NoteModel.findOne({
        _id: noteId,
        isDeleted: false,
    }).select('content title notebookId createUser');
    if (!note) {
        // 软删/不存在 → 无需重建（deleteNote 已硬删 chunk），不记失败
        log.info('reindex 跳过：笔记不存在或已删除', { noteId });
        return buildEmptyResult(noteId, 'NOTE_NOT_FOUND');
    }

    // 重新切分（纯函数，parent/child 均带 contentHash）
    const { parents, children } = chunkMarkdown(note.content);

    // 旧分块（按 chunkType 拆 parent / child）
    const oldChunks = await NoteChunk.find({ noteId })
        .select('chunkType contentHash parentId sectionPath')
        .lean<LeanChunk[]>();
    const oldParents = oldChunks.filter(
        (c): c is LeanChunk & { chunkType: 'parent' } =>
            c.chunkType === 'parent',
    );
    const oldChildren = oldChunks.filter(
        (c): c is LeanChunk & { chunkType: 'child' } => c.chunkType === 'child',
    );

    const oldParentByHash = new Map(oldParents.map((p) => [p.contentHash, p]));
    const oldChildByHash = new Map(oldChildren.map((c) => [c.contentHash, c]));
    const newParentHashSet = new Set(parents.map((p) => p.contentHash));
    const newChildHashSet = new Set(children.map((c) => c.contentHash));

    /* 1. parent diff：只增删变化的章节块（parent 不向量化） */
    const parentsToInsert = parents.filter(
        (p) => !oldParentByHash.has(p.contentHash),
    );
    const parentsToDelete = oldParents.filter(
        (p) => !newParentHashSet.has(p.contentHash),
    );

    // parentId 解析表：新 parents 数组的 contentHash → 持久化 parent _id
    // （复用的旧块用旧 _id，新增块预生成 _id，child 按 parentIndex 经此映射）
    const parentIdByHash = new Map<string, mongoose.Types.ObjectId>();
    for (const p of oldParents) {
        if (newParentHashSet.has(p.contentHash)) {
            parentIdByHash.set(p.contentHash, p._id);
        }
    }
    let parentsInserted = 0;
    if (parentsToInsert.length > 0) {
        const docs = parentsToInsert.map((p) => {
            const id = new mongoose.Types.ObjectId();
            parentIdByHash.set(p.contentHash, id);
            return {
                _id: id,
                noteId: note._id,
                notebookId: note.notebookId,
                userId: note.createUser,
                title: note.title,
                chunkType: 'parent' as const,
                sectionPath: p.sectionPath,
                chunkIndex: p.chunkIndex,
                content: p.content,
                searchText: tokenize(p.content),
                contentHash: p.contentHash,
            };
        });
        await NoteChunk.insertMany(docs);
        parentsInserted = docs.length;
    }

    /* 2. child diff：content 未变 → 复用（父块变更时仅更新引用，避免悬挂 parentId）；
           content 变化 → 重新 embedding 后入库 */
    const toInsert: Array<{
        child: ChildChunk;
        parentId: mongoose.Types.ObjectId;
    }> = [];
    const toReParent: Array<{
        id: mongoose.Types.ObjectId;
        parentId: mongoose.Types.ObjectId;
        sectionPath: string[];
    }> = [];
    let unchanged = 0;

    for (const child of children) {
        const parent = parents[child.parentIndex];
        if (!parent) continue; // 防御：切分器保证 parentIndex 有效
        const parentId = parentIdByHash.get(parent.contentHash);
        if (!parentId) continue; // 防御：所有新 parent 均已入库或复用旧块
        const old = oldChildByHash.get(child.contentHash);
        if (old) {
            // contentHash 相同 → 内容未变，不 re-embed；父块或标题路径变了才更新引用
            const parentChanged =
                old.parentId?.toString() !== parentId.toString();
            const pathChanged =
                JSON.stringify(old.sectionPath) !==
                JSON.stringify(child.sectionPath);
            if (parentChanged || pathChanged) {
                toReParent.push({
                    id: old._id,
                    parentId,
                    sectionPath: child.sectionPath,
                });
            } else {
                unchanged++;
            }
        } else {
            toInsert.push({ child, parentId });
        }
    }

    let childrenReParented = 0;
    if (toReParent.length > 0) {
        await NoteChunk.bulkWrite(
            toReParent.map((r) => ({
                updateOne: {
                    filter: { _id: r.id },
                    update: {
                        $set: {
                            parentId: r.parentId,
                            sectionPath: r.sectionPath,
                        },
                    },
                },
            })),
            { ordered: false },
        );
        childrenReParented = toReParent.length;
    }

    /* 3. 新增 child：批量向量化后 bulkWrite 入库 */
    let childrenInserted = 0;
    let embeddingTokens = 0;
    if (toInsert.length > 0) {
        const { embeddings, totalTokens } = await generateEmbeddings(
            toInsert.map(({ child }) => child.content),
        );
        embeddingTokens = totalTokens;
        if (embeddings.length !== toInsert.length) {
            log.warn(
                'embedding 返回数量与待入库 child 不一致，按最小长度对齐',
                {
                    noteId,
                    expected: toInsert.length,
                    actual: embeddings.length,
                },
            );
        }
        const insertOps = toInsert.map(({ child, parentId }, i) => ({
            insertOne: {
                document: {
                    noteId: note._id,
                    notebookId: note.notebookId,
                    userId: note.createUser,
                    title: note.title,
                    chunkType: 'child' as const,
                    parentId,
                    sectionPath: child.sectionPath,
                    chunkIndex: child.chunkIndex,
                    content: child.content,
                    embedding: embeddings[i], // 对齐异常时缺失向量，仅可用 BM25
                    searchText: tokenize(child.content),
                    contentHash: child.contentHash,
                },
            },
        }));
        const res = await NoteChunk.bulkWrite(insertOps, { ordered: false });
        childrenInserted = res.insertedCount || 0;
    }

    /* 4. 删除：contentHash 已不在新切分结果的旧块（物理删除，派生数据不软删） */
    let childrenDeleted = 0;
    const childrenToDelete = oldChildren.filter(
        (c) => !newChildHashSet.has(c.contentHash),
    );
    if (childrenToDelete.length > 0) {
        const res = await NoteChunk.deleteMany({
            _id: { $in: childrenToDelete.map((c) => c._id) },
        });
        childrenDeleted = res.deletedCount || 0;
    }

    let parentsDeleted = 0;
    if (parentsToDelete.length > 0) {
        const res = await NoteChunk.deleteMany({
            _id: { $in: parentsToDelete.map((p) => p._id) },
        });
        parentsDeleted = res.deletedCount || 0;
    }

    /* 5. title 同步：仅标题变更（内容未变）时批量更新，不触发 embedding */
    // 仅标题实际变化才同步，避免每轮无谓写
    const titleMismatch = await NoteChunk.exists({
        noteId,
        title: { $ne: note.title },
    });
    if (titleMismatch) {
        await NoteChunk.updateMany({ noteId }, { $set: { title: note.title } });
    }

    const durationMs = Date.now() - start;
    log.info('reindex 完成', {
        noteId,
        duration_ms: durationMs,
        parentsInserted,
        parentsDeleted,
        childrenInserted,
        childrenReParented,
        childrenDeleted,
        unchanged,
        embeddingTokens,
        parents: parents.map((p) => p.content),
        children: children.map((p) => p.content),
    });

    return {
        noteId,
        parentsInserted,
        parentsDeleted,
        childrenInserted,
        childrenReParented,
        childrenDeleted,
        unchanged,
        embeddingTokens,
        durationMs,
    };
}

/* ------------------------------------------------------------------ */
/* 队列 helper（note.service 增删改 hook 调用，fire-and-forget）         */
/* ------------------------------------------------------------------ */

/**
 * 把笔记标记为待重建（幂等 SADD）。不 await、不抛错，保证不阻塞增删改响应。
 */
export function markNoteDirty(noteId: string): void {
    redisClient.sAdd(PENDING_KEY, noteId).catch((error) => {
        log.error('笔记脏标记入队失败', error as Error, { noteId });
    });
}

/**
 * 删除笔记时清理派生索引：硬删 NoteChunk + 清掉脏标记/失败计数/死信。
 */
export async function removeNoteIndex(noteId: string): Promise<void> {
    // 关键操作：硬删派生 chunk。失败兜底重试——孤儿 chunk 会污染检索
    await withRetry(() => NoteChunk.deleteMany({ noteId }), {
        attempts: 3,
        baseDelay: 200,
        maxDelay: 2000,
        logger: log,
    });

    // Redis 清理尽力而为：键残留无害（软删笔记 reindex 是 no-op），
    // 用 allSettled 避免单个 Redis 故障掩盖上面的 chunk 删除结果
    const results = await Promise.allSettled([
        redisClient.sRem(PENDING_KEY, noteId),
        redisClient.sRem(DEAD_KEY, noteId),
        redisClient.del(`${FAIL_KEY_PREFIX}${noteId}`),
    ]);
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            log.warn(
                '清理 Redis 标记失败（尽力而为，键残留无害）',
                r.reason as Error,
                {
                    noteId,
                    op: i,
                },
            );
        }
    });
}

/* ------------------------------------------------------------------ */
/* 后台单 worker（递归 setTimeout + try/catch 兜底，不用 setInterval）   */
/* ------------------------------------------------------------------ */

let workerStarted = false;
let pollTimer: NodeJS.Timeout | null = null;

export function startNoteReindexWorker(
    intervalMs: number = POLL_INTERVAL_MS,
): void {
    if (workerStarted) return; // 幂等，防重复启动
    workerStarted = true;
    log.info('note reindex worker 启动', { pollIntervalMs: intervalMs });
    // 启动时立即扫一次 pending，处理进程重启前的积压
    void pollOnce(intervalMs);
}

/** 未被调用过 */
export function stopNoteReindexWorker(): void {
    workerStarted = false;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    log.info('note reindex worker 停止');
}

async function pollOnce(intervalMs: number): Promise<void> {
    // log.info('定时扫描 reindex 笔记');
    try {
        // MongoDB 未就绪时跳过本轮，避免把基础设施故障误计成笔记失败
        if (
            mongoose.connection.readyState !==
            mongoose.ConnectionStates.connected
        ) {
            log.warn('MongoDB 未就绪，跳过本轮 reindex 扫描');
        } else {
            const pending = await redisClient.sMembers(PENDING_KEY);
            if (pending.length > 0) {
                log.info(`reindex 扫描到 ${pending.length} 个待处理笔记`);
            }
            // 单 worker 串行处理：个人知识库低频任务，无需并发，避免打满 embedding API
            for (const noteId of pending) {
                await processOne(noteId);
            }
        }
    } catch (error) {
        log.error('reindex worker 单轮扫描异常', error as Error);
    } finally {
        if (workerStarted) {
            pollTimer = setTimeout(() => {
                void pollOnce(intervalMs);
            }, intervalMs);
        }
    }
}

async function processOne(noteId: string): Promise<void> {
    const failKey = `${FAIL_KEY_PREFIX}${noteId}`;
    try {
        await incrementalReindex(noteId);
    } catch (error) {
        // 失败：计数 +1，超过上限移入死信停止重试（不 SREM，保留现场便于排查）
        const failCount = await redisClient.incr(failKey);
        if (failCount > MAX_FAILS) {
            await redisClient.sAdd(DEAD_KEY, noteId);
            log.warn(`reindex 连续失败超过 ${MAX_FAILS} 次，移入死信停止重试`, {
                noteId,
                failCount,
                error: error as Error,
            });
        } else {
            log.error(`reindex 失败（第 ${failCount}/${MAX_FAILS} 次）`, {
                noteId,
                error: error as Error,
            });
        }
        return;
    }
    // 成功：消费脏标记并重置失败计数。Redis 瞬时故障仅告警（reindex 幂等，下轮重试）
    try {
        await Promise.all([
            redisClient.sRem(PENDING_KEY, noteId),
            redisClient.del(failKey),
        ]);
    } catch (error) {
        log.error('reindex 成功后清理脏标记失败', error as Error, { noteId });
    }
}

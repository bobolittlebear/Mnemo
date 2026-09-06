// src/services/notebook/noteSearch.service.ts
// 笔记 RAG 检索：对 NoteChunk 做「向量 + BM25 双路召回 → RRF(k=60) 融合 → 父子块上下文展开」。
// 只检索 child 块（parent 不向量化、不作为检索单元）；parent 仅用于命中 child 的上下文回填。
// 检索失败（embedding 异常 / DB 异常）一律向上抛错，由调用方（W4 注入层）降级，本服务不吞异常。
import mongoose from 'mongoose';
import { NoteChunk } from '@/models/NoteChunk';
import { generateEmbedding } from '@/lib/embedding';
import { tokenize } from '@/utils/tokenizer';
import { createLogger } from '@/lib/logger';

const log = createLogger('rag');

export interface NoteRetrievalResult {
    chunkId: string; // _id 映射
    noteId: string;
    notebookId: string;
    title: string;
    sectionPath: string[];
    chunkIndex: number;
    content: string;
    parentContext: string;
    score: number;
}

export interface SearchNotesParams {
    userId: string;
    query: string;
    mode?: 'hybrid' | 'vector' | 'bm25'; // 默认 hybrid
    notebookId?: string;
    topK?: number;
}

const RRF_K = 60; // RRF 平滑因子，与 LTM 检索保持一致
const DEFAULT_TOP_K = 8;
const VECTOR_INDEX = 'vector_index'; // NoteChunk 的 Atlas 向量索引（云端手动创建，命名对齐 memorySearch）

/** child 块候选（rank 0-based） */
interface ChildCandidate {
    _id: string;
    noteId: mongoose.Types.ObjectId;
    notebookId: mongoose.Types.ObjectId;
    title: string;
    sectionPath: string[];
    chunkIndex: number;
    content: string;
    parentId?: mongoose.Types.ObjectId | null;
    rank: number;
}

/** $vectorSearch / $text 投影出的 child 字段（供结果填充 + parentId 回填） */
interface ChunkProjection {
    _id: mongoose.Types.ObjectId;
    noteId: mongoose.Types.ObjectId;
    notebookId: mongoose.Types.ObjectId;
    title: string;
    sectionPath: string[];
    chunkIndex: number;
    content: string;
    parentId?: mongoose.Types.ObjectId | null;
}

interface ParentLean {
    _id: mongoose.Types.ObjectId;
    content: string;
}

const CHUNK_PROJECTION = {
    _id: 1,
    noteId: 1,
    notebookId: 1,
    title: 1,
    sectionPath: 1,
    chunkIndex: 1,
    content: 1,
    parentId: 1,
};

/** 检索前置过滤：userId + chunkType:child 必选，notebookId 可选（交集过滤） */
function buildFilter(
    userId: string,
    notebookId?: string,
): Record<string, { $eq: unknown }> {
    const filter: Record<string, { $eq: unknown }> = {
        userId: { $eq: userId },
        chunkType: { $eq: 'child' },
    };
    if (notebookId) {
        filter.notebookId = { $eq: new mongoose.Types.ObjectId(notebookId) };
    }
    return filter;
}

function toCandidate(doc: ChunkProjection, rank: number): ChildCandidate {
    return {
        _id: doc._id.toString(),
        noteId: doc.noteId,
        notebookId: doc.notebookId,
        title: doc.title,
        sectionPath: doc.sectionPath,
        chunkIndex: doc.chunkIndex,
        content: doc.content,
        parentId: doc.parentId,
        rank,
    };
}

/** 向量路：$vectorSearch（Atlas 向量索引），取前 limit 个候选 */
async function vectorSearch(
    userId: string,
    queryEmbedding: number[],
    limit: number,
    notebookId?: string,
): Promise<ChildCandidate[]> {
    const pipeline = [
        {
            $vectorSearch: {
                index: VECTOR_INDEX,
                path: 'embedding',
                queryVector: queryEmbedding,
                numCandidates: Math.max(limit, 100),
                limit,
                filter: buildFilter(userId, notebookId),
            },
        },
        { $project: CHUNK_PROJECTION },
    ] satisfies mongoose.PipelineStage[];

    const start = Date.now();
    const docs = await NoteChunk.aggregate<ChunkProjection>(pipeline);
    log.info('笔记向量检索完成', {
        count: docs.length,
        duration_ms: Date.now() - start,
    });
    return docs.map((doc, index) => toCandidate(doc, index));
}

/** BM25 路：中文分词后走 searchText 文本索引，取前 limit 个候选 */
async function textSearch(
    userId: string,
    query: string,
    limit: number,
    notebookId?: string,
): Promise<ChildCandidate[]> {
    const scalarFilter: Record<string, unknown> = {
        userId,
        chunkType: 'child',
    };
    if (notebookId) {
        scalarFilter.notebookId = new mongoose.Types.ObjectId(notebookId);
    }

    const pipeline = [
        { $match: { $text: { $search: tokenize(query) } } },
        { $addFields: { textScore: { $meta: 'textScore' } } },
        { $match: scalarFilter },
        { $sort: { textScore: -1 } },
        { $limit: limit },
        { $project: CHUNK_PROJECTION },
    ] satisfies mongoose.PipelineStage[];

    const start = Date.now();
    const docs = await NoteChunk.aggregate<ChunkProjection>(pipeline);
    log.info('笔记关键词检索完成', {
        count: docs.length,
        duration_ms: Date.now() - start,
    });
    return docs.map((doc, index) => toCandidate(doc, index));
}

/** RRF 融合：RRF(d) = Σ 1/(RRF_K + rank)，rank 0-based，跨路按 docId 累加 */
function rrfFuse(
    vectorDocs: ChildCandidate[],
    textDocs: ChildCandidate[],
    topK: number,
): Array<{ doc: ChildCandidate; score: number }> {
    const acc = new Map<string, { doc: ChildCandidate; score: number }>();
    for (const doc of [...vectorDocs, ...textDocs]) {
        const contribution = 1 / (RRF_K + doc.rank);
        const existing = acc.get(doc._id);
        if (existing) existing.score += contribution;
        else acc.set(doc._id, { doc, score: contribution });
    }
    return Array.from(acc.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

export async function searchNotes(
    params: SearchNotesParams,
): Promise<NoteRetrievalResult[]> {
    const {
        userId,
        query,
        notebookId,
        mode = 'hybrid',
        topK = DEFAULT_TOP_K,
    } = params;
    if (!query || !query.trim()) return [];

    const trimmedQuery = query.trim();
    const candidateLimit = topK * 2;
    const start = Date.now();

    const { embeddings } = await generateEmbedding(trimmedQuery);
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) throw new Error('生成查询向量失败');

    log.info('笔记检索模式', { mode });

    const [vectorRes, textRes] = await Promise.allSettled([
        mode !== 'bm25'
            ? vectorSearch(userId, queryEmbedding, candidateLimit, notebookId)
            : [],
        mode !== 'vector'
            ? textSearch(userId, trimmedQuery, candidateLimit, notebookId)
            : [],
    ]);
    const vectorDocs = vectorRes.status === 'fulfilled' ? vectorRes.value : [];
    const textDocs = textRes.status === 'fulfilled' ? textRes.value : [];
    if (vectorRes.status === 'rejected')
        log.warn('笔记向量检索失败', { error: vectorRes.reason });
    if (textRes.status === 'rejected')
        log.warn('笔记关键词检索失败', { error: textRes.reason });

    const fused = rrfFuse(vectorDocs, textDocs, topK);
    if (fused.length === 0) return [];

    // 父子展开：收集命中 child 的 parentId（去重）→ 一次 $in 取回 parent 全文
    const parentIds = Array.from(
        new Set(
            fused
                .map(({ doc }) => doc.parentId?.toString())
                .filter((id): id is string => Boolean(id)),
        ),
    );
    const parentContent = new Map<string, string>();
    if (parentIds.length > 0) {
        const parents = await NoteChunk.find({ _id: { $in: parentIds } })
            .select('content')
            .lean<ParentLean[]>();
        for (const parent of parents) {
            parentContent.set(parent._id.toString(), parent.content);
        }
    }

    const results = fused.map(({ doc, score }) => ({
        chunkId: doc._id.toString(),
        noteId: doc.noteId.toString(),
        notebookId: doc.notebookId.toString(),
        title: doc.title,
        sectionPath: doc.sectionPath,
        chunkIndex: doc.chunkIndex,
        content: doc.content,
        parentContext: doc.parentId
            ? (parentContent.get(doc.parentId.toString()) ?? '')
            : '',
        score,
    }));

    log.info('笔记检索完成', {
        count: results.length,
        duration_ms: Date.now() - start,
    });
    return results;
}

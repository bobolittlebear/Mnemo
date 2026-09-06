/// <reference types="node" />
// scripts/run-note-recall-eval.ts
// 笔记 RAG 召回评测 Runner（C 段）。
// 连真实 Atlas（dev），对 searchNotes 三模式（vector / bm25 / hybrid）做真实检索，
// 按方案 §8 计算 recall@K、hybrid≥vector、BM25 互补、negative 无命中，
// 产出可追溯报告到 tests/evals/reports/YYYY-MM-DD_<tag>.md。
//
// 运行：EVAL_USER_ID=<真实 NoteChunk.userId> pnpm eval:note-recall
// 可选环境变量：EVAL_TOP_K（默认 5）、EVAL_REPORT_TAG（默认 manual）。
//
// 隐私：报告只含 query / id / 分数，不含任何 note 正文（v4 §5）。
// 无 CI：仅手动执行，不引入自动门禁（v4 §10）。
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// 先加载 .env.development：ts-node CJS 按源码顺序 emit require（实测不提升到语句前），
// 后续 import 的模块在其模块作用域读 process.env 时已拿到完整环境变量。
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
    quiet: true, // dotenv v17 默认打印 banner，评测脚本静默加载
});

import mongoose from 'mongoose';
import { NoteChunk } from '../src/models/NoteChunk'; // 引入即触发 Schema 注册
import { searchNotes } from '../src/services/notebook/noteSearch.service';
import type { SearchNotesParams } from '../src/services/notebook/noteSearch.service';
// 注意：searchNotes 返回 NoteRetrievalResult[]，此处仅取 chunkId 作为排名
import { generateEmbedding } from '../src/lib/embedding';
import { DEFAULT_CHUNK_CONFIG } from '../src/utils/noteChunker';

const MODES = ['vector', 'bm25', 'hybrid'] as const;
type Mode = (typeof MODES)[number];

/* ------------------------------------------------------------------ */
/* 阈值常量（对齐 v4 方案 §8）                                          */
/* ------------------------------------------------------------------ */

/** GT chunk 缺失率上限，超过判"需重新标注"（退出码 2） */
const CHUNK_ID_MISSING_RATIO_LIMIT = 0.2;
/** hybrid 相对 vector 单条允许退化 1 chunk（小样本噪声容忍） */
const HYBRID_SINGLE_CHUNK_TOLERANCE = 1;
/** 退化条数容忍上限：>20% query 退化超 1 chunk 才判失败 */
const HYBRID_DEGRADED_RATIO_LIMIT = 0.2;
/** BM25 互补 query 数下限（≥2 通过） */
const BM25_COMPLEMENT_MIN = 2;
/** negative 向量路 top5 最高余弦风险线（>0.5 标记"潜在误召回风险"） */
const NEGATIVE_COSINE_RISK_THRESHOLD = 0.5;

const HEX_ID_RE = /^[0-9a-fA-F]{24}$/;

// 数据集路径：默认 tests/evals/datasets/note-recall-queries.json，
// 可用 EVAL_DATASET 覆盖（例如指向带真实 chunkId 的另一份标注，便于与占位模板隔离）。
const DATASET_PATH = process.env.EVAL_DATASET
    ? path.resolve(process.env.EVAL_DATASET)
    : path.join(process.cwd(), 'tests/evals/datasets/note-recall-queries.json');
const REPORTS_DIR = path.join(process.cwd(), 'tests/evals/reports');

/* ------------------------------------------------------------------ */
/* 类型定义                                                            */
/* ------------------------------------------------------------------ */

/** 数据集 query 条目（tests/evals/datasets/note-recall-queries.json 的 queries[]） */
interface EvalQuery {
    id: string;
    query: string;
    targetChunkIds: string[];
    type: string;
    /** 仅 cross-notebook 类型携带，验证笔记本过滤正确性 */
    notebookId?: string;
}

type QueryCategory = 'hand' | 'synthetic' | 'negative';

/** 单条 query 的三路检索结果 */
interface QueryResult {
    query: EvalQuery;
    rankings: Record<Mode, string[]>;
    modeErrors: Partial<Record<Mode, string>>;
    /** negative 观察：向量路 top5 最高余弦分 */
    negativeMaxCosine?: number;
    negativeRisk?: boolean;
}

/** 单条 query 的 recall 行（negative 行为 null 表示 GT 空、不适用） */
interface RecallRow {
    queryId: string;
    query: string;
    type: string;
    category: QueryCategory;
    gtCount: number;
    vectorRecall3: number | null;
    vectorRecall5: number | null;
    bm25Recall5: number | null;
    hybridRecall3: number | null;
    hybridRecall5: number | null;
    /** hybrid@5 命中 < vector@5 命中 - 1 → 退化 */
    hybridDegraded: boolean;
}

interface Metrics {
    rows: RecallRow[];
    nonNegativeCount: number;
    vectorMacroRecall5: number;
    hybridMacroRecall5: number;
    hybridDegradedCount: number;
    hybridDegradedRatio: number;
    hybridPass: boolean;
    bm25ComplementCases: Array<{ queryId: string; chunkIds: string[] }>;
    bm25Pass: boolean;
    negativeObservations: Array<{
        queryId: string;
        maxCosine: number;
        risk: boolean;
    }>;
}

interface CorpusSnapshot {
    count: number;
    latestUpdatedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function categorize(type: string): QueryCategory {
    if (type === 'negative') return 'negative';
    if (type === 'code-token' || type === 'synthetic-edge') return 'synthetic';
    return 'hand'; // paraphrase / exact / cross-notebook / 其他未知均按手标计
}

function isValidHexId(id: string): boolean {
    return HEX_ID_RE.test(id);
}

function fmtRatio(r: number): string {
    return `${(r * 100).toFixed(1)}%`;
}

function fmtRecall(v: number | null): string {
    return v === null ? 'n/a' : v.toFixed(2);
}

/** 余弦相似度（存储向量未强制归一化，按定义计算，零向量返回 0） */
function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** GT 命中数：|gt ∩ topK(ranking)| */
function hitCount(ranking: string[], gt: Set<string>, k: number): number {
    let hits = 0;
    for (const id of ranking.slice(0, k)) {
        if (gt.has(id)) hits++;
    }
    return hits;
}

/** recall@K = |gt ∩ topK(ranking)| / |gt|；GT 为空返回 null（归 negative 处理） */
function recallAtK(
    ranking: string[],
    gt: Set<string>,
    k: number,
): number | null {
    if (gt.size === 0) return null;
    return hitCount(ranking, gt, k) / gt.size;
}

/** 解析并校验数据集；结构非法抛错，单条非法跳过并告警 */
function parseQueries(value: unknown): EvalQuery[] {
    if (!Array.isArray(value)) {
        throw new Error('数据集缺少 queries 数组');
    }
    const out: EvalQuery[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            console.warn('跳过非法 query 条目：非对象');
            continue;
        }
        const rec = item as Record<string, unknown>;
        const { id, query, type, targetChunkIds, notebookId } = rec;
        if (
            typeof id !== 'string' ||
            !id ||
            typeof query !== 'string' ||
            !query.trim() ||
            typeof type !== 'string' ||
            !type
        ) {
            console.warn(
                `跳过非法 query 条目：缺 id / query / type（${JSON.stringify({ id, query, type })}）`,
            );
            continue;
        }
        if (
            !Array.isArray(targetChunkIds) ||
            !targetChunkIds.every(
                (c): c is string => typeof c === 'string' && isValidHexId(c),
            )
        ) {
            console.warn(`跳过 ${id}：targetChunkIds 缺失/含非法 24 位 hex`);
            continue;
        }
        // 类型约束：negative 必须空 GT；非 negative 必须有非空 GT
        if (type === 'negative') {
            if (targetChunkIds.length > 0) {
                console.warn(
                    `跳过 ${id}：negative 类型 targetChunkIds 必须为空`,
                );
                continue;
            }
        } else if (targetChunkIds.length === 0) {
            console.warn(
                `跳过 ${id}：非 negative 类型 targetChunkIds 不能为空`,
            );
            continue;
        }
        if (
            notebookId !== undefined &&
            (typeof notebookId !== 'string' || !isValidHexId(notebookId))
        ) {
            console.warn(`跳过 ${id}：notebookId 须为合法 24 位 hex`);
            continue;
        }
        out.push({
            id,
            query: query.trim(),
            targetChunkIds: targetChunkIds as string[],
            type,
            ...(notebookId !== undefined ? { notebookId } : {}),
        });
    }
    return out;
}

/** GT chunk 失效检测（§8）：全量 GT 去重后查库，缺失率 >20% 判"需重新标注" */
async function checkGtChunkIds(queries: EvalQuery[]): Promise<number> {
    const gtIds = Array.from(new Set(queries.flatMap((q) => q.targetChunkIds)));
    if (gtIds.length === 0) return 0; // 全 negative 场景，无 GT 可校验
    const found = await NoteChunk.countDocuments({ _id: { $in: gtIds } });
    const missing = gtIds.length - found;
    const ratio = missing / gtIds.length;
    console.log(
        `GT chunk 校验：去重 ${gtIds.length} 个，命中 ${found}，缺失 ${missing}（${fmtRatio(ratio)}）`,
    );
    return ratio;
}

/** 语料一致性快照（§8/3.1）：count + 最新 updatedAt */
async function snapshotCorpus(userId: string): Promise<CorpusSnapshot> {
    const [count, latest] = await Promise.all([
        NoteChunk.countDocuments({ userId }),
        NoteChunk.findOne({ userId })
            .sort({ updatedAt: -1 })
            .select('updatedAt')
            .lean<{ updatedAt?: Date }>(),
    ]);
    return {
        count,
        latestUpdatedAt: latest?.updatedAt
            ? latest.updatedAt.toISOString()
            : null,
    };
}

/** 单条 query 三路检索；单路失败记错误并按空排名处理，不中断整体评测 */
async function runOneQuery(
    q: EvalQuery,
    userId: string,
    topK: number,
): Promise<QueryResult> {
    const rankings: Record<Mode, string[]> = {
        vector: [],
        bm25: [],
        hybrid: [],
    };
    const modeErrors: Partial<Record<Mode, string>> = {};

    for (const mode of MODES) {
        const params: SearchNotesParams = {
            userId,
            query: q.query,
            mode,
            topK,
        };
        if (q.notebookId) params.notebookId = q.notebookId; // cross-notebook 验证过滤
        try {
            const res = await searchNotes(params);
            rankings[mode] = res.map((r) => r.chunkId);
        } catch (error) {
            modeErrors[mode] =
                error instanceof Error ? error.message : String(error);
            rankings[mode] = [];
        }
    }

    console.log(
        `  已评测 ${q.id}（${q.type}）${q.notebookId ? `notebook=${q.notebookId}` : ''}：` +
            `vector=${rankings.vector.length} bm25=${rankings.bm25.length} hybrid=${rankings.hybrid.length}`,
    );
    return { query: q, rankings, modeErrors };
}

/** negative 附加观察（§8，非断言）：向量路 top5 与 query 的最高余弦，>0.5 标记误召回风险 */
async function observeNegative(results: QueryResult[]): Promise<void> {
    for (const r of results) {
        if (categorize(r.query.type) !== 'negative') continue;
        const top5 = r.rankings.vector.slice(0, 5);
        r.negativeMaxCosine = 0;
        r.negativeRisk = false;
        if (top5.length === 0) continue;

        let queryEmbedding: number[] | undefined;
        try {
            const { embeddings } = await generateEmbedding(r.query.query);
            queryEmbedding = embeddings[0];
        } catch (error) {
            console.warn(
                `  negative 观察跳过 ${r.query.id}：query 向量生成失败`,
                error,
            );
            continue;
        }
        if (!queryEmbedding) continue;

        let maxCosine = 0;
        for (const id of top5) {
            try {
                const chunk = await NoteChunk.findById(id)
                    .select('embedding')
                    .lean<{ embedding?: number[] }>();
                if (chunk?.embedding && chunk.embedding.length > 0) {
                    maxCosine = Math.max(
                        maxCosine,
                        cosineSimilarity(queryEmbedding, chunk.embedding),
                    );
                }
            } catch {
                // 单 chunk 读取失败忽略（该 id 可能已随语料变更消失）
            }
        }
        r.negativeMaxCosine = maxCosine;
        r.negativeRisk = maxCosine > NEGATIVE_COSINE_RISK_THRESHOLD;
        console.log(
            `  negative 观察 ${r.query.id}：向量路 top5 最高余弦 ${maxCosine.toFixed(3)}` +
                (r.negativeRisk ? ' ⚠️ 潜在误召回风险' : ''),
        );
    }
}

/** 按 §8 计算指标 */
function computeMetrics(results: QueryResult[]): Metrics {
    const rows: RecallRow[] = [];
    const bm25ComplementCases: Array<{ queryId: string; chunkIds: string[] }> =
        [];
    const negativeObservations: Array<{
        queryId: string;
        maxCosine: number;
        risk: boolean;
    }> = [];

    let vectorSum = 0;
    let hybridSum = 0;
    let nonNegativeCount = 0;
    let hybridDegradedCount = 0;

    for (const r of results) {
        const gt = new Set(r.query.targetChunkIds);
        const cat = categorize(r.query.type);

        if (cat === 'negative') {
            negativeObservations.push({
                queryId: r.query.id,
                maxCosine: r.negativeMaxCosine ?? 0,
                risk: r.negativeRisk ?? false,
            });
            rows.push({
                queryId: r.query.id,
                query: r.query.query,
                type: r.query.type,
                category: cat,
                gtCount: 0,
                vectorRecall3: null,
                vectorRecall5: null,
                bm25Recall5: null,
                hybridRecall3: null,
                hybridRecall5: null,
                hybridDegraded: false,
            });
            continue;
        }

        const vec5Hits = hitCount(r.rankings.vector, gt, 5);
        const hy5Hits = hitCount(r.rankings.hybrid, gt, 5);
        const bm5Hits = hitCount(r.rankings.bm25, gt, 5);

        const hybridDegraded =
            hy5Hits < vec5Hits - HYBRID_SINGLE_CHUNK_TOLERANCE;
        if (hybridDegraded) hybridDegradedCount++;

        // BM25 互补：向量路 top5 未命中 GT，但 BM25 路 top5 命中（以 GT 为准）
        if (vec5Hits === 0 && bm5Hits >= 1) {
            const hitChunkIds = r.rankings.bm25
                .slice(0, 5)
                .filter((id) => gt.has(id));
            bm25ComplementCases.push({
                queryId: r.query.id,
                chunkIds: hitChunkIds,
            });
        }

        const vectorRecall3 = recallAtK(r.rankings.vector, gt, 3);
        const vectorRecall5 = recallAtK(r.rankings.vector, gt, 5);
        const bm25Recall5 = recallAtK(r.rankings.bm25, gt, 5);
        const hybridRecall3 = recallAtK(r.rankings.hybrid, gt, 3);
        const hybridRecall5 = recallAtK(r.rankings.hybrid, gt, 5);
        if (vectorRecall5 !== null) vectorSum += vectorRecall5;
        if (hybridRecall5 !== null) hybridSum += hybridRecall5;
        nonNegativeCount++;

        rows.push({
            queryId: r.query.id,
            query: r.query.query,
            type: r.query.type,
            category: cat,
            gtCount: gt.size,
            vectorRecall3,
            vectorRecall5,
            bm25Recall5,
            hybridRecall3,
            hybridRecall5,
            hybridDegraded,
        });
    }

    const vectorMacroRecall5 = nonNegativeCount
        ? vectorSum / nonNegativeCount
        : 0;
    const hybridMacroRecall5 = nonNegativeCount
        ? hybridSum / nonNegativeCount
        : 0;
    const hybridDegradedRatio = nonNegativeCount
        ? hybridDegradedCount / nonNegativeCount
        : 0;
    // §8：仅当 macro-avg(hybrid) < macro-avg(vector) 或退化条数超容忍才判失败
    const hybridPass = !(
        hybridMacroRecall5 < vectorMacroRecall5 ||
        hybridDegradedRatio > HYBRID_DEGRADED_RATIO_LIMIT
    );
    const bm25Pass = bm25ComplementCases.length >= BM25_COMPLEMENT_MIN;

    return {
        rows,
        nonNegativeCount,
        vectorMacroRecall5,
        hybridMacroRecall5,
        hybridDegradedCount,
        hybridDegradedRatio,
        hybridPass,
        bm25ComplementCases,
        bm25Pass,
        negativeObservations,
    };
}

/* ------------------------------------------------------------------ */
/* 报告输出（§12）                                                       */
/* ------------------------------------------------------------------ */

interface ReportData {
    userId: string;
    topK: number;
    embeddingModel: string;
    vectorDim: number;
    chunkConfig: typeof DEFAULT_CHUNK_CONFIG;
    bm25Tokenizer: string;
    corpusNotes: number;
    corpusChunks: number;
    queryCounts: {
        total: number;
        hand: number;
        synthetic: number;
        negative: number;
    };
    baseline: string;
    generatedAt: string;
    gtMissingRatio: number;
    corpusMutated: boolean;
    corpusBefore: CorpusSnapshot;
    corpusAfter: CorpusSnapshot;
    metrics: Metrics;
    errors: Array<{ queryId: string; mode: Mode; message: string }>;
}

function buildReport(data: ReportData): string {
    const m = data.metrics;
    const L: string[] = [];

    L.push('# 笔记 RAG 召回评测报告');
    L.push('');
    L.push('> 本报告仅含 query / id / 分数，不含任何 note 正文（v4 §5）。');
    L.push('');
    L.push('## 环境与参数');
    L.push('');
    L.push(`- embedding_model: ${data.embeddingModel}`);
    L.push(`- vector_dim: ${data.vectorDim}`);
    L.push(
        `- chunk_params: \`{ maxParentTokens: ${data.chunkConfig.maxParentTokens}, ` +
            `maxChildTokens: ${data.chunkConfig.maxChildTokens}, ` +
            `minChildTokens: ${data.chunkConfig.minChildTokens}, ` +
            `overlap: N/A, semantic_threshold: N/A }\` ` +
            `（来源：src/utils/noteChunker.ts DEFAULT_CHUNK_CONFIG；` +
            `token-aware 结构切分，无滑窗 overlap / 无语义阈值）`,
    );
    L.push(`- bm25_tokenizer: ${data.bm25Tokenizer}`);
    L.push(
        `- corpus_size: \`{ notes: ${data.corpusNotes}, chunks: ${data.corpusChunks} }\` ` +
            `（user 维度：distinct noteId + child chunks）`,
    );
    L.push(
        `- query_count: \`{ total: ${data.queryCounts.total}, hand: ${data.queryCounts.hand}, ` +
            `synthetic: ${data.queryCounts.synthetic}, negative: ${data.queryCounts.negative} }\``,
    );
    L.push(`- baseline: ${data.baseline}`);
    L.push(`- generated_at: ${data.generatedAt}`);
    L.push(`- top_k: ${data.topK}`);
    L.push(`- eval_user: ${data.userId}`);
    L.push('');

    L.push('## 汇总判定');
    L.push('');
    L.push('| 检查项 | 结论 | 说明 |');
    L.push('|---|---|---|');
    if (data.baseline === 'establishing') {
        L.push(
            '| 向量路 recall@K | establishing | 首份报告无对比对象，见下方 recall 表 |',
        );
    } else {
        L.push(
            `| 向量路 recall@K | 参考 ${data.baseline} | 与基线报告 recall 表人工比对 |`,
        );
    }
    L.push(
        `| hybrid ≥ vector | ${m.hybridPass ? '✅ PASS' : '❌ FAIL'} | ` +
            `macro-avg recall@5：vector=${m.vectorMacroRecall5.toFixed(3)} → hybrid=${m.hybridMacroRecall5.toFixed(3)}；` +
            `退化条数 ${m.hybridDegradedCount}/${m.nonNegativeCount}（${fmtRatio(m.hybridDegradedRatio)}，容忍 ≤${fmtRatio(HYBRID_DEGRADED_RATIO_LIMIT)}） |`,
    );
    L.push(
        `| BM25 互补 | ${m.bm25Pass ? '✅ PASS' : '❌ FAIL'} | ` +
            `互补 query 数 ${m.bm25ComplementCases.length}（≥${BM25_COMPLEMENT_MIN}） |`,
    );
    L.push(
        `| negative 无命中 | ✅ PASS | GT 为空，三路 top5 与空集无交集（天然满足）；风险标记 ${m.negativeObservations.filter((n) => n.risk).length} 条 |`,
    );
    L.push(
        data.corpusMutated
            ? '| corpus 一致性 | ⚠️ corpus mutated | 评测期间语料变化，结果仅供参考 |'
            : '| corpus 一致性 | ✅ 一致 | 评测前后 count / updatedAt 未变 |',
    );
    L.push(
        `| GT chunk 缺失率 | ${fmtRatio(data.gtMissingRatio)} | 超过 ${fmtRatio(CHUNK_ID_MISSING_RATIO_LIMIT)} 会中止并要求重新标注 |`,
    );
    L.push('');

    L.push('## 各模式 recall@K');
    L.push('');
    L.push(
        '| query_id | type | query | gt | vec@3 | vec@5 | bm25@5 | hyb@3 | hyb@5 | 退化 |',
    );
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const row of m.rows) {
        L.push(
            `| ${row.queryId} | ${row.type} | ${row.query} | ${row.gtCount} | ` +
                `${fmtRecall(row.vectorRecall3)} | ${fmtRecall(row.vectorRecall5)} | ` +
                `${fmtRecall(row.bm25Recall5)} | ${fmtRecall(row.hybridRecall3)} | ` +
                `${fmtRecall(row.hybridRecall5)} | ${row.hybridDegraded ? '是' : '否'} |`,
        );
    }
    L.push('');

    L.push('## hybrid ≥ vector');
    L.push('');
    L.push(
        `- macro-avg recall@5：vector = ${m.vectorMacroRecall5.toFixed(3)}，hybrid = ${m.hybridMacroRecall5.toFixed(3)}`,
    );
    L.push(
        `- 退化 query（hybrid@5 命中 < vector@5 命中 − ${HYBRID_SINGLE_CHUNK_TOLERANCE}）：${m.hybridDegradedCount} 条（列表见上方 recall 表"退化"列）`,
    );
    L.push('');

    L.push('## BM25 互补 case');
    L.push('');
    if (m.bm25ComplementCases.length === 0) {
        L.push('无：向量路 top5 未命中但 BM25 top5 命中的 query 不存在。');
    } else {
        L.push('| query_id | BM25 命中的 GT chunkId |');
        L.push('|---|---|');
        for (const c of m.bm25ComplementCases) {
            L.push(`| ${c.queryId} | ${c.chunkIds.join(', ')} |`);
        }
    }
    L.push('');

    L.push('## negative 观察');
    L.push('');
    if (m.negativeObservations.length === 0) {
        L.push('无 negative query。');
    } else {
        L.push('| query_id | 向量路 top5 最高余弦 | 误召回风险 |');
        L.push('|---|---|---|');
        for (const n of m.negativeObservations) {
            L.push(
                `| ${n.queryId} | ${n.maxCosine.toFixed(3)} | ${n.risk ? '⚠️ > 0.5' : '无'} |`,
            );
        }
        L.push('');
        L.push(
            '> 注：风险标记仅作参考观察（§8），非断言；>0.5 提示"潜在误召回风险"。',
        );
    }
    L.push('');

    if (data.errors.length > 0) {
        L.push('## 模式调用错误记录');
        L.push('');
        L.push('| query_id | mode | error |');
        L.push('|---|---|---|');
        for (const e of data.errors) {
            L.push(`| ${e.queryId} | ${e.mode} | ${e.message} |`);
        }
        L.push('');
        L.push(
            '> 注：出错模式按空排名处理（recall 计 0），不影响其他模式与整体流程。',
        );
        L.push('');
    }

    if (data.corpusMutated) {
        L.push('## ⚠️ corpus mutated');
        L.push('');
        L.push(
            `评测前 count=${data.corpusBefore.count} latestUpdatedAt=${data.corpusBefore.latestUpdatedAt ?? 'null'}；` +
                `评测后 count=${data.corpusAfter.count} latestUpdatedAt=${data.corpusAfter.latestUpdatedAt ?? 'null'}。` +
                `评测期间语料发生变化，本报告结果仅供参考，建议重跑。`,
        );
        L.push('');
    }

    return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
    // 1. 环境校验
    const userId = process.env.EVAL_USER_ID;
    if (!userId) {
        console.error(
            '缺少 EVAL_USER_ID 环境变量：请指定要评测的真实用户（NoteChunk.userId）',
        );
        process.exit(1);
    }
    const rawTopK = Number(process.env.EVAL_TOP_K ?? 5);
    const topK = Number.isInteger(rawTopK) && rawTopK > 0 ? rawTopK : 5;
    if (topK !== rawTopK) {
        console.warn(
            `EVAL_TOP_K 非法（${process.env.EVAL_TOP_K}），回退默认 5`,
        );
    }
    const reportTag = process.env.EVAL_REPORT_TAG || 'manual';

    // 2. 读数据集
    console.log(`读数据集：${DATASET_PATH}`);
    if (!fs.existsSync(DATASET_PATH)) {
        console.error(`数据集不存在：${DATASET_PATH}`);
        process.exit(1);
    }
    let queries: EvalQuery[];
    try {
        const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')) as {
            queries?: unknown;
        };
        queries = parseQueries(raw.queries);
    } catch (error) {
        console.error('数据集解析失败', error);
        process.exit(1);
    }
    if (queries.length === 0) {
        console.error('数据集无有效 query（可能全部为占位/非法 id），无法评测');
        process.exit(1);
    }
    const counts = {
        total: queries.length,
        hand: queries.filter((q) => categorize(q.type) === 'hand').length,
        synthetic: queries.filter((q) => categorize(q.type) === 'synthetic')
            .length,
        negative: queries.filter((q) => categorize(q.type) === 'negative')
            .length,
    };
    console.log(
        `有效 query ${queries.length} 条：hand=${counts.hand} synthetic=${counts.synthetic} negative=${counts.negative}`,
    );

    // 3. 连库（autoIndex:false 防触发索引同步，镜像 check-indexes.ts 约定）
    const MONGO_URI =
        process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';
    await mongoose.connect(MONGO_URI, { autoIndex: false });
    console.log('已连接 MongoDB，开始评测');

    try {
        // 4. GT chunk 失效检测（§8）：>20% 缺失 → 需重新标注
        const gtMissingRatio = await checkGtChunkIds(queries);
        if (gtMissingRatio > CHUNK_ID_MISSING_RATIO_LIMIT) {
            console.error(
                `GT chunk 缺失率 ${fmtRatio(gtMissingRatio)} 超过 ${fmtRatio(CHUNK_ID_MISSING_RATIO_LIMIT)}：需重新标注后重跑`,
            );
            process.exitCode = 2;
            return;
        }

        // 5. 语料一致性前快照（§8/3.1）
        const corpusBefore = await snapshotCorpus(userId);
        console.log(
            `语料快照（前）：count=${corpusBefore.count} latestUpdatedAt=${corpusBefore.latestUpdatedAt ?? 'null'}`,
        );

        // 6. 三模式真实检索
        const results: QueryResult[] = [];
        console.log(`开始评测 ${queries.length} 条 query（topK=${topK}）…`);
        for (const q of queries) {
            results.push(await runOneQuery(q, userId, topK));
        }

        // 7. negative 附加观察（非断言）
        await observeNegative(results);

        // 8. 语料一致性后快照
        const corpusAfter = await snapshotCorpus(userId);
        const corpusMutated =
            corpusBefore.count !== corpusAfter.count ||
            corpusBefore.latestUpdatedAt !== corpusAfter.latestUpdatedAt;
        console.log(
            `语料快照（后）：count=${corpusAfter.count} latestUpdatedAt=${corpusAfter.latestUpdatedAt ?? 'null'} ` +
                (corpusMutated ? '⚠️ corpus mutated' : '（一致）'),
        );

        // 9. 指标计算
        const metrics = computeMetrics(results);
        const errors: Array<{ queryId: string; mode: Mode; message: string }> =
            [];
        for (const r of results) {
            for (const mode of MODES) {
                const msg = r.modeErrors[mode];
                if (msg)
                    errors.push({ queryId: r.query.id, mode, message: msg });
            }
        }
        console.log(
            `指标：hybrid macro-avg recall@5=${metrics.hybridMacroRecall5.toFixed(3)}` +
                `（vector=${metrics.vectorMacroRecall5.toFixed(3)}），退化 ${metrics.hybridDegradedCount} 条，` +
                `BM25 互补 ${metrics.bm25ComplementCases.length} 条`,
        );

        // 10. 写报告
        const date = new Date().toISOString().slice(0, 10);
        const filename = `${date}_${reportTag}.md`;
        const reportPath = path.join(REPORTS_DIR, filename);
        // baseline 追溯链（§9）：取 reports/ 下已存在的最新一份报告文件名；无则首份 establishing
        let baseline = 'establishing';
        let priorFiles: string[] = [];
        try {
            priorFiles = fs
                .readdirSync(REPORTS_DIR)
                .filter((f) => f.endsWith('.md'))
                .sort();
        } catch {
            // REPORTS_DIR 尚不存在 → 首份
        }
        if (priorFiles.length > 0) {
            baseline = priorFiles[priorFiles.length - 1]!;
        }

        const corpusNotes = (await NoteChunk.distinct('noteId', { userId }))
            .length;
        const corpusChunks = await NoteChunk.countDocuments({
            userId,
            chunkType: 'child',
        });

        const report = buildReport({
            userId,
            topK,
            embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-v4',
            vectorDim: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
            chunkConfig: DEFAULT_CHUNK_CONFIG,
            bm25Tokenizer: 'jieba-wasm',
            corpusNotes,
            corpusChunks,
            queryCounts: counts,
            baseline,
            generatedAt: new Date().toISOString(),
            gtMissingRatio,
            corpusMutated,
            corpusBefore,
            corpusAfter,
            metrics,
            errors,
        });

        fs.mkdirSync(REPORTS_DIR, { recursive: true });
        fs.writeFileSync(reportPath, report, 'utf-8');
        console.log(`\n✅ 报告已写入：${reportPath}`);
        console.log(
            `   基线：${baseline}（后续报告将引用本报告作为 baseline）`,
        );
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error('评测执行失败', error);
    process.exitCode = 1;
});

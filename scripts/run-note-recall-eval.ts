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
    /** hybrid 排名质量（仅 non-negative 有值） */
    hybridMrr: number | null;
    hybridNdcg5: number | null;
    hybridPrecision5: number | null;
    /** 双盲：向量路@5 与 BM25 路@5 均未命中 GT */
    doubleBlind: boolean;
}

/** 单 type 的 macro 聚合（该 type 内各 query 指标的均值） */
interface TypeMacro {
    type: string;
    count: number;
    vectorRecall5: number;
    bm25Recall5: number;
    hybridRecall5: number;
    hybridMrr: number;
    hybridNdcg5: number;
    hybridPrecision5: number;
}

interface Metrics {
    rows: RecallRow[];
    nonNegativeCount: number;
    vectorMacroRecall5: number;
    hybridMacroRecall5: number;
    hybridDegradedCount: number;
    hybridDegradedRatio: number;
    hybridPass: boolean;
    bm25MacroRecall5: number;
    bm25ComplementCases: Array<{ queryId: string; chunkIds: string[] }>;
    bm25Pass: boolean;
    negativeObservations: Array<{
        queryId: string;
        maxCosine: number;
        risk: boolean;
    }>;
    /** 分类 macro：按 type 聚合（非 category），各 type 均值再取均 */
    typeMacro: TypeMacro[];
    classificationMacro: {
        vectorRecall5: number;
        bm25Recall5: number;
        hybridRecall5: number;
        hybridMrr: number;
        hybridNdcg5: number;
        hybridPrecision5: number;
    };
    /** hybrid ≥ vector（macro-avg recall@5） */
    hybridGeVectorPass: boolean;
    /** hybrid ≥ bm25（macro-avg recall@5） */
    hybridGeBm25Pass: boolean;
    /** hybrid ≥ max(vector, bm25)（macro-avg recall@5） */
    hybridGeMaxPass: boolean;
    /** 双盲桶：两单模态@5 均未命中的 query */
    doubleBlindCases: Array<{ queryId: string; type: string; gtCount: number }>;
    doubleBlindCount: number;
    /** 各模式 macro-avg 排名质量 */
    vectorMacroMrr: number;
    vectorMacroNdcg5: number;
    vectorMacroPrecision5: number;
    bm25MacroMrr: number;
    bm25MacroNdcg5: number;
    bm25MacroPrecision5: number;
    hybridMacroMrr: number;
    hybridMacroNdcg5: number;
    hybridMacroPrecision5: number;
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

/** 首个 GT 命中排名（1-based，限 topK）；无命中返回 0 */
function firstHitRank(ranking: string[], gt: Set<string>, k: number): number {
    const limit = Math.min(ranking.length, k);
    for (let i = 0; i < limit; i++) {
        if (gt.has(ranking[i]!)) return i + 1;
    }
    return 0;
}

/** MRR@K：首个 GT 命中 1/rank，无命中 0（二值相关性，GT 非空） */
function mrrAtK(ranking: string[], gt: Set<string>, k: number): number {
    const r = firstHitRank(ranking, gt, k);
    return r === 0 ? 0 : 1 / r;
}

/** nDCG@K（二值相关性）：DCG/IDCG；GT 为空由调用方归 null */
function ndcgAtK(ranking: string[], gt: Set<string>, k: number): number {
    const idealCount = Math.min(gt.size, k);
    let dcg = 0;
    let idcg = 0;
    for (let i = 0; i < k; i++) {
        const rel = i < ranking.length && gt.has(ranking[i]!) ? 1 : 0;
        const idealRel = i < idealCount ? 1 : 0;
        dcg += rel / Math.log2(i + 2);
        idcg += idealRel / Math.log2(i + 2);
    }
    return idcg > 0 ? dcg / idcg : 0;
}

/** precision@K = |gt ∩ topK| / K（分母固定为 K，衡量 topK 纯净度） */
function precisionAtK(ranking: string[], gt: Set<string>, k: number): number {
    return hitCount(ranking, gt, k) / k;
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

/** 按 §8 计算指标（含 §8+ 排名质量：MRR / nDCG@5 / precision@5 + 分类 macro + 双盲桶） */
function computeMetrics(results: QueryResult[]): Metrics {
    const rows: RecallRow[] = [];
    const bm25ComplementCases: Array<{ queryId: string; chunkIds: string[] }> =
        [];
    const doubleBlindCases: Array<{
        queryId: string;
        type: string;
        gtCount: number;
    }> = [];
    const negativeObservations: Array<{
        queryId: string;
        maxCosine: number;
        risk: boolean;
    }> = [];

    let vectorRecall5Sum = 0;
    let bm25Recall5Sum = 0;
    let hybridRecall5Sum = 0;
    let nonNegativeCount = 0;
    let hybridDegradedCount = 0;

    // 各模式排名质量累加（non-negative 全量）
    let vectorMrrSum = 0;
    let vectorNdcgSum = 0;
    let vectorPrecSum = 0;
    let bm25MrrSum = 0;
    let bm25NdcgSum = 0;
    let bm25PrecSum = 0;
    let hybridMrrSum = 0;
    let hybridNdcgSum = 0;
    let hybridPrecSum = 0;

    // 分类 macro 累加器：type → 各指标求和
    const typeAcc = new Map<
        string,
        {
            count: number;
            vectorRecall5: number;
            bm25Recall5: number;
            hybridRecall5: number;
            hybridMrr: number;
            hybridNdcg5: number;
            hybridPrecision5: number;
        }
    >();

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
                hybridMrr: null,
                hybridNdcg5: null,
                hybridPrecision5: null,
                doubleBlind: false,
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

        // 双盲：两单模态@5 均未命中 GT（诊断桶，非断言失败）
        const doubleBlind = vec5Hits === 0 && bm5Hits === 0;
        if (doubleBlind) {
            doubleBlindCases.push({
                queryId: r.query.id,
                type: r.query.type,
                gtCount: gt.size,
            });
        }

        const vectorRecall3 = recallAtK(r.rankings.vector, gt, 3);
        const vectorRecall5 = recallAtK(r.rankings.vector, gt, 5)!;
        const bm25Recall5 = recallAtK(r.rankings.bm25, gt, 5)!;
        const hybridRecall3 = recallAtK(r.rankings.hybrid, gt, 3);
        const hybridRecall5 = recallAtK(r.rankings.hybrid, gt, 5)!;

        const vecMrr = mrrAtK(r.rankings.vector, gt, 5);
        const vecNdcg = ndcgAtK(r.rankings.vector, gt, 5);
        const vecPrec = precisionAtK(r.rankings.vector, gt, 5);
        const bmMrr = mrrAtK(r.rankings.bm25, gt, 5);
        const bmNdcg = ndcgAtK(r.rankings.bm25, gt, 5);
        const bmPrec = precisionAtK(r.rankings.bm25, gt, 5);
        const hyMrr = mrrAtK(r.rankings.hybrid, gt, 5);
        const hyNdcg = ndcgAtK(r.rankings.hybrid, gt, 5);
        const hyPrec = precisionAtK(r.rankings.hybrid, gt, 5);

        vectorRecall5Sum += vectorRecall5;
        bm25Recall5Sum += bm25Recall5;
        hybridRecall5Sum += hybridRecall5;
        vectorMrrSum += vecMrr;
        vectorNdcgSum += vecNdcg;
        vectorPrecSum += vecPrec;
        bm25MrrSum += bmMrr;
        bm25NdcgSum += bmNdcg;
        bm25PrecSum += bmPrec;
        hybridMrrSum += hyMrr;
        hybridNdcgSum += hyNdcg;
        hybridPrecSum += hyPrec;
        nonNegativeCount++;

        // 分类 macro 累加
        const acc = typeAcc.get(r.query.type) ?? {
            count: 0,
            vectorRecall5: 0,
            bm25Recall5: 0,
            hybridRecall5: 0,
            hybridMrr: 0,
            hybridNdcg5: 0,
            hybridPrecision5: 0,
        };
        acc.count += 1;
        acc.vectorRecall5 += vectorRecall5;
        acc.bm25Recall5 += bm25Recall5;
        acc.hybridRecall5 += hybridRecall5;
        acc.hybridMrr += hyMrr;
        acc.hybridNdcg5 += hyNdcg;
        acc.hybridPrecision5 += hyPrec;
        typeAcc.set(r.query.type, acc);

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
            hybridMrr: hyMrr,
            hybridNdcg5: hyNdcg,
            hybridPrecision5: hyPrec,
            doubleBlind,
        });
    }

    const vectorMacroRecall5 = nonNegativeCount
        ? vectorRecall5Sum / nonNegativeCount
        : 0;
    const bm25MacroRecall5 = nonNegativeCount
        ? bm25Recall5Sum / nonNegativeCount
        : 0;
    const hybridMacroRecall5 = nonNegativeCount
        ? hybridRecall5Sum / nonNegativeCount
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

    // 排名质量 macro（各模式）
    const vectorMacroMrr = nonNegativeCount
        ? vectorMrrSum / nonNegativeCount
        : 0;
    const vectorMacroNdcg5 = nonNegativeCount
        ? vectorNdcgSum / nonNegativeCount
        : 0;
    const vectorMacroPrecision5 = nonNegativeCount
        ? vectorPrecSum / nonNegativeCount
        : 0;
    const bm25MacroMrr = nonNegativeCount ? bm25MrrSum / nonNegativeCount : 0;
    const bm25MacroNdcg5 = nonNegativeCount
        ? bm25NdcgSum / nonNegativeCount
        : 0;
    const bm25MacroPrecision5 = nonNegativeCount
        ? bm25PrecSum / nonNegativeCount
        : 0;
    const hybridMacroMrr = nonNegativeCount
        ? hybridMrrSum / nonNegativeCount
        : 0;
    const hybridMacroNdcg5 = nonNegativeCount
        ? hybridNdcgSum / nonNegativeCount
        : 0;
    const hybridMacroPrecision5 = nonNegativeCount
        ? hybridPrecSum / nonNegativeCount
        : 0;

    // 分类 macro：各 type 均值 → 再取均（每 type 等权）
    const typeMacro: TypeMacro[] = Array.from(typeAcc.entries()).map(
        ([type, acc]) => ({
            type,
            count: acc.count,
            vectorRecall5: acc.vectorRecall5 / acc.count,
            bm25Recall5: acc.bm25Recall5 / acc.count,
            hybridRecall5: acc.hybridRecall5 / acc.count,
            hybridMrr: acc.hybridMrr / acc.count,
            hybridNdcg5: acc.hybridNdcg5 / acc.count,
            hybridPrecision5: acc.hybridPrecision5 / acc.count,
        }),
    );
    const tCount = typeMacro.length;
    const mean = (sel: (t: TypeMacro) => number) =>
        tCount ? typeMacro.reduce((s, t) => s + sel(t), 0) / tCount : 0;
    const classificationMacro = {
        vectorRecall5: mean((t) => t.vectorRecall5),
        bm25Recall5: mean((t) => t.bm25Recall5),
        hybridRecall5: mean((t) => t.hybridRecall5),
        hybridMrr: mean((t) => t.hybridMrr),
        hybridNdcg5: mean((t) => t.hybridNdcg5),
        hybridPrecision5: mean((t) => t.hybridPrecision5),
    };

    const hybridGeVectorPass = hybridMacroRecall5 >= vectorMacroRecall5;
    const hybridGeBm25Pass = hybridMacroRecall5 >= bm25MacroRecall5;
    const hybridGeMaxPass =
        hybridMacroRecall5 >= Math.max(vectorMacroRecall5, bm25MacroRecall5);

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
        typeMacro,
        classificationMacro,
        hybridGeVectorPass,
        hybridGeBm25Pass,
        hybridGeMaxPass,
        doubleBlindCases,
        doubleBlindCount: doubleBlindCases.length,
        vectorMacroMrr,
        vectorMacroNdcg5,
        vectorMacroPrecision5,
        bm25MacroRecall5,
        bm25MacroMrr,
        bm25MacroNdcg5,
        bm25MacroPrecision5,
        hybridMacroMrr,
        hybridMacroNdcg5,
        hybridMacroPrecision5,
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
    corpusChunksTotal: number;
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
        `- corpus_size: \`{ notes: ${data.corpusNotes}, child_chunks: ${data.corpusChunks}, all_chunks_incl_parent: ${data.corpusChunksTotal} }\` ` +
            `（child_chunks 为检索单元；all_chunks_incl_parent 含父块占位，对应评测日志 count）`,
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
        `| hybrid ≥ vector | ${m.hybridGeVectorPass ? '✅ PASS' : '❌ FAIL'} | ` +
            `macro-avg recall@5：vector=${m.vectorMacroRecall5.toFixed(3)} → hybrid=${m.hybridMacroRecall5.toFixed(3)} |`,
    );
    L.push(
        `| hybrid ≥ bm25 | ${m.hybridGeBm25Pass ? '✅ PASS' : '❌ FAIL'} | ` +
            `macro-avg recall@5：bm25=${m.bm25MacroRecall5.toFixed(3)} → hybrid=${m.hybridMacroRecall5.toFixed(3)} |`,
    );
    L.push(
        `| hybrid ≥ max(vector,bm25) | ${m.hybridGeMaxPass ? '✅ PASS' : '❌ FAIL'} | ` +
            `hybrid 不弱于任一单模态整体均值 |`,
    );
    L.push(
        `| 退化容忍 | ${m.hybridPass ? '✅ PASS' : '❌ FAIL'} | ` +
            `退化条数 ${m.hybridDegradedCount}/${m.nonNegativeCount}（${fmtRatio(m.hybridDegradedRatio)}，容忍 ≤${fmtRatio(HYBRID_DEGRADED_RATIO_LIMIT)}）；` +
            `注：hybrid≥vector 与退化容忍为两条独立判定 |`,
    );
    L.push(
        `| 分类 macro recall@5 | reference | ` +
            `hybrid=${m.classificationMacro.hybridRecall5.toFixed(3)}（各 type 等权均值，见"分类 macro"表） |`,
    );
    L.push(
        `| 双盲桶 | ${m.doubleBlindCount === 0 ? '✅ 无' : `⚠️ ${m.doubleBlindCount} 条`} | ` +
            `两单模态@5 均未命中 GT（vec@5=0 且 bm25@5=0），见"双盲桶"表 |`,
    );
    L.push(
        `| 排名质量（hybrid） | reference | ` +
            `MRR=${m.hybridMacroMrr.toFixed(3)}，nDCG@5=${m.hybridMacroNdcg5.toFixed(3)}，precision@5=${m.hybridMacroPrecision5.toFixed(3)} |`,
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

    L.push('## 分类 macro（按 type 聚合）');
    L.push('');
    L.push(
        '> 各 type 内取 query 指标均值，再对各 type 等权取均（macro）。' +
            '与"全局 macro"不同：全局 macro 被样本多的 type 主导，分类 macro 让每类平等发声。',
    );
    L.push('');
    L.push(
        '| type | n | vec@5 | bm25@5 | hyb@5 | hyb MRR | hyb nDCG@5 | hyb P@5 |',
    );
    L.push('|---|---|---|---|---|---|---|---|');
    for (const t of m.typeMacro) {
        L.push(
            `| ${t.type} | ${t.count} | ${t.vectorRecall5.toFixed(2)} | ` +
                `${t.bm25Recall5.toFixed(2)} | ${t.hybridRecall5.toFixed(2)} | ` +
                `${t.hybridMrr.toFixed(3)} | ${t.hybridNdcg5.toFixed(3)} | ` +
                `${t.hybridPrecision5.toFixed(3)} |`,
        );
    }
    L.push(
        `| **分类 macro** | ${m.nonNegativeCount} | ` +
            `${m.classificationMacro.vectorRecall5.toFixed(2)} | ` +
            `${m.classificationMacro.bm25Recall5.toFixed(2)} | ` +
            `${m.classificationMacro.hybridRecall5.toFixed(2)} | ` +
            `${m.classificationMacro.hybridMrr.toFixed(3)} | ` +
            `${m.classificationMacro.hybridNdcg5.toFixed(3)} | ` +
            `${m.classificationMacro.hybridPrecision5.toFixed(3)} |`,
    );
    L.push('');

    L.push('## 双盲桶（vec@5=0 且 bm25@5=0）');
    L.push('');
    L.push(
        '> 两单模态在 top5 均未命中 GT 的 query。这类是真正的"盲区"：融合也无回天之力，' +
            '需从 query 改写 / 标注 / 语料覆盖排查，而非调融合算法。诊断项，非断言失败。',
    );
    L.push('');
    if (m.doubleBlindCases.length === 0) {
        L.push('无：所有 non-negative query 至少有一种单模态在 top5 命中 GT。');
    } else {
        L.push('| query_id | type | gt 数 |');
        L.push('|---|---|---|');
        for (const c of m.doubleBlindCases) {
            L.push(`| ${c.queryId} | ${c.type} | ${c.gtCount} |`);
        }
    }
    L.push('');

    L.push('## 排名质量（MRR / nDCG@5 / precision@5）');
    L.push('');
    L.push(
        '> recall@5 衡量"召回全不全"，三者补"排得好不好"：' +
            'MRR 看首个相关项位置（越小 rank 越高分）；nDCG@5 看相关性折扣累积；' +
            'precision@5 看 top5 纯净度。GT 二值相关性（命中=1）。',
    );
    L.push('');
    L.push('| mode | recall@5 | MRR | nDCG@5 | precision@5 |');
    L.push('|---|---|---|---|---|');
    L.push(
        `| vector | ${m.vectorMacroRecall5.toFixed(3)} | ${m.vectorMacroMrr.toFixed(3)} | ` +
            `${m.vectorMacroNdcg5.toFixed(3)} | ${m.vectorMacroPrecision5.toFixed(3)} |`,
    );
    L.push(
        `| bm25 | ${m.bm25MacroRecall5.toFixed(3)} | ${m.bm25MacroMrr.toFixed(3)} | ` +
            `${m.bm25MacroNdcg5.toFixed(3)} | ${m.bm25MacroPrecision5.toFixed(3)} |`,
    );
    L.push(
        `| hybrid | ${m.hybridMacroRecall5.toFixed(3)} | ${m.hybridMacroMrr.toFixed(3)} | ` +
            `${m.hybridMacroNdcg5.toFixed(3)} | ${m.hybridMacroPrecision5.toFixed(3)} |`,
    );
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
            corpusChunksTotal: corpusBefore.count,
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

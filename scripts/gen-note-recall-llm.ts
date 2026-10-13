/// <reference types="node" />
// scripts/gen-note-recall-llm.ts
// 基于活库 dump（note-chunks-dump.json）用 LLM 生成笔记 RAG 召回评测 query 数据集。
//
// 与 build-note-recall-dataset.ts（jieba 关键词重叠替换 GT）的核心区别：
//   1) LLM 基于真实 chunk 内容生成自然 query，而非关键词重叠；
//   2) GT 的 _id 由 LLM 回传它"看到的"真实 _id，并强制校验 ∈ dump（防幻觉）；
//   3) 硬门禁 top-5：每条非 negative query 必须能被 searchNotes 真实检索到（target ∈ top5），否则丢弃。
//
// 用法（项目根目录）：
//   pnpm gen:note-recall-llm
//   EVAL_USER_ID=<id> pnpm gen:note-recall-llm
//   EVAL_DUMP_PATH=<path> TARGET_MIN=50 TARGET_MAX=60 PER_NOTE=4 pnpm gen:note-recall-llm
//
// 输出：tests/evals/datasets/note-recall-queries.llm.json（EvalQuery[]，可直接 EVAL_DATASET 喂评测）
//       tests/evals/reports/YYYY-MM-DD_note-recall-llm.md（生成复核报告）
// 不写回 curated note-recall-queries.json。
//
// 注意：需连真实 Atlas（dev）且 AI_BASE_URL / AI_API_KEY 就绪（searchNotes 走向量检索、createChat 走 LLM）。
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
    quiet: true,
});

import mongoose from 'mongoose';
import { createChat } from '../src/services/ai.service';
import { searchNotes } from '../src/services/notebook/noteSearch.service';

const DATASET_DIR = path.join(process.cwd(), 'tests/evals/datasets');
const REPORTS_DIR = path.join(process.cwd(), 'tests/evals/reports');

const DUMP_PATH =
    process.env.EVAL_DUMP_PATH ||
    path.join(DATASET_DIR, 'note-chunks-dump.json');
const OUT_PATH = path.join(DATASET_DIR, 'note-recall-queries.llm.json');

const TARGET_MIN = Number(process.env.TARGET_MIN) || 50;
const TARGET_MAX = Number(process.env.TARGET_MAX) || 60;
const PER_NOTE = Number(process.env.PER_NOTE) || 4; // 每 note 最多向 LLM 请求的 query 数
const CONCURRENCY = Number(process.env.GEN_CONCURRENCY) || 4;
const TOP_K_GATE = 5;

// ---------- 类型 ----------
interface DumpChunk {
    _id: string;
    userId: string;
    notebookId: string | null;
    noteId: string | null;
    title: string;
    chunkType: string;
    content: string;
}

interface LlmQuery {
    query: string;
    type: string;
    sourceId: string; // LLM 回传的 _id
    notebookId?: string;
}

interface KeptQuery {
    id: string;
    query: string;
    type: string;
    targetChunkIds: string[];
    notebookId?: string;
}

interface NoteGroup {
    noteId: string;
    title: string;
    notebookId: string | null;
    chunks: DumpChunk[];
}

const TYPE_SET = new Set([
    'exact',
    'paraphrase',
    'code-token',
    'cross-notebook',
    'synthetic-edge',
    'negative',
]);

// ---------- 纯函数（可被单测） ----------
/** 去掉 ```json 代码围栏包裹 */
export function stripFence(s: string): string {
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const inner = m ? m[1] : s;
    return (inner ?? '').trim();
}

/**
 * 鲁棒解析 LLM 返回的 query 列表。
 * 接受 {queries:[...]} 或 [...]，每条需含 query 字符串。
 * 非法 JSON 抛错（由调用方决定重试）。
 */
export function parseLlmQueries(raw: string): LlmQuery[] {
    const text = stripFence(raw);
    const obj = JSON.parse(text);
    const arr = Array.isArray(obj) ? obj : (obj as { queries?: unknown })?.queries;
    if (!Array.isArray(arr)) {
        throw new Error('LLM 返回无 queries 数组');
    }
    return arr
        .filter((q: unknown): q is Record<string, unknown> => {
            if (!q || typeof q !== 'object') return false;
            const rec = q as Record<string, unknown>;
            const query = rec.query;
            if (typeof query !== 'string') return false;
            // 空白串（含纯空格）视为非法，避免 trim 后落空 query
            return query.trim() !== '';
        })
        .map((q: Record<string, unknown>) => ({
            query: String(q.query).trim(),
            type: String(q.type ?? '').trim().toLowerCase(),
            sourceId: String(q.sourceId ?? q.targetChunkId ?? '').trim(),
            notebookId: q.notebookId ? String(q.notebookId).trim() : undefined,
        }));
}

// ---------- 工具 ----------
function shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = a[i]!;
        a[i] = a[j]!;
        a[j] = tmp;
    }
    return a;
}

async function runPool<T, R>(
    items: T[],
    worker: (item: T, idx: number) => Promise<R>,
    concurrency: number,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(concurrency, items.length))
        .fill(0)
        .map(async () => {
            while (cursor < items.length) {
                const i = cursor++;
                results[i] = await worker(items[i] as T, i);
            }
        });
    await Promise.all(runners);
    return results;
}

/** 调用 LLM 生成 query，解析失败以 temperature=0 重试一次 */
async function callLlm(system: string, user: string): Promise<LlmQuery[]> {
    const opts = { enableThinking: false, temperature: 0.8 } as const;
    try {
        const r1 = await createChat(
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            opts,
        );
        try {
            return parseLlmQueries(r1.content);
        } catch {
            const r2 = await createChat(
                [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                { ...opts, temperature: 0 },
            );
            return parseLlmQueries(r2.content);
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`⚠️ LLM 调用失败跳过：${msg}`);
        return [];
    }
}

// ---------- Prompt ----------
function buildSystemPrompt(): string {
    return `你是一个笔记 RAG 召回评测数据集生成器。你会收到某篇笔记的标题与若干"子块"（child chunk）内容，每块带有真实 _id。
请基于这些块生成用户可能向 AI 笔记助手提出的"自然检索 query"，用于测试召回系统能否把对应块找出来。
要求：
- 每条 query 必须标注它对应的 sourceId（只能是所给块中的某一个 _id，严禁编造不存在的 _id）。
- type 取值之一：exact（近字面复述块中关键词）、paraphrase（同义改写/换说法）、code-token（块含代码/接口/命令时，用标识符或报错信息提问）、synthetic-edge（组合/推演/边界场景提问）、cross-notebook（措辞泛化、不点名笔记，但答案落在该笔记，需带 notebookId）、negative（与所给内容无关的自然提问，sourceId 填空字符串）。
- 优先覆盖 exact / paraphrase / code-token（若块含代码）/ synthetic-edge；穿插 1 条 cross-notebook（泛化措辞）与 1 条 negative（无关但自然）。
- negative 的 sourceId 必须为 ""（空），其余类型的 sourceId 必须非空且 ∈ 所给列表。
- 不要输出任何解释，只输出 JSON：{"queries":[{"query":"...","type":"...","sourceId":"...","notebookId":"..."}]}`;
}

function buildUserPrompt(note: NoteGroup): string {
    const blocks = note.chunks
        .map(
            (c, i) =>
                `块${i + 1} [_id=${c._id}]\n${c.content.slice(0, 600)}`,
        )
        .join('\n\n');
    return `笔记标题：${note.title}\n笔记本 notebookId：${note.notebookId ?? '无'}\n\n以下子块内容（每块带真实 _id，sourceId 只能从中选）：\n${blocks}\n\n请生成最多 ${PER_NOTE} 条 query（按上面规则覆盖多类型），只返回 JSON。`;
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
    if (!fs.existsSync(DUMP_PATH)) {
        console.error(
            `dump 文件不存在：${DUMP_PATH}\n请先跑：pnpm dump:note-chunks --userId <id>`,
        );
        process.exit(1);
    }
    const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf-8')) as {
        userId: string | null;
        chunks: DumpChunk[];
    };
    const userId =
        process.argv.slice(2).reduce<string | undefined>((acc, a, idx, arr) => {
            if (a === '--userId') return arr[idx + 1];
            return acc;
        }, undefined) ||
        process.env.EVAL_USER_ID ||
        dump.userId ||
        undefined;

    if (!userId) {
        console.error(
            '无法解析 userId（dump.userId 为空且未传 --userId/EVAL_USER_ID）',
        );
        process.exit(1);
    }

    const childChunks = dump.chunks.filter((c) => c.chunkType === 'child');
    const validIds = new Set(childChunks.map((c) => c._id.toLowerCase()));
    const idToChunk = new Map(
        childChunks.map((c) => [c._id.toLowerCase(), c]),
    );

    // 按 note 分组
    const notesMap = new Map<string, DumpChunk[]>();
    for (const c of childChunks) {
        if (!c.noteId) continue;
        const arr = notesMap.get(c.noteId) ?? [];
        arr.push(c);
        notesMap.set(c.noteId, arr);
    }
    const notes: NoteGroup[] = shuffle(
        [...notesMap.entries()]
            .map(([noteId, chunks]) => {
                const first = chunks[0];
                if (!first) return null;
                return {
                    noteId,
                    title: first.title,
                    notebookId: first.notebookId,
                    chunks,
                } as NoteGroup;
            })
            .filter((x): x is NoteGroup => x !== null),
    );

    // 连库（searchNotes 需要真实检索）
    const MONGO_URI =
        process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';
    await mongoose.connect(MONGO_URI, { autoIndex: false });

    const kept: KeptQuery[] = [];
    const stats = {
        generated: 0,
        droppedInvalidId: 0,
        droppedGate: 0,
        droppedNegative: 0,
        droppedOther: 0,
    };

    const system = buildSystemPrompt();

    const processNote = async (note: NoteGroup): Promise<void> => {
        if (kept.length >= TARGET_MAX) return;
        const user = buildUserPrompt(note);
        const llmQs = await callLlm(system, user);
        for (const lq of llmQs) {
            if (kept.length >= TARGET_MAX) break;
            stats.generated++;
            const t = lq.type.toLowerCase();
            if (!TYPE_SET.has(t)) {
                stats.droppedOther++;
                continue;
            }
            if (t === 'negative') {
                // negative：GT 空，软校验 top-5 不含本笔记任意块
                const hits = await searchNotes({
                    userId,
                    query: lq.query,
                    topK: TOP_K_GATE,
                });
                const hitsThisNote = hits.some((h) => {
                    const ch = idToChunk.get(h.chunkId.toLowerCase());
                    return ch !== undefined && ch.noteId === note.noteId;
                });
                if (hitsThisNote) {
                    stats.droppedNegative++;
                    continue;
                }
                kept.push({
                    id: '',
                    query: lq.query,
                    type: 'negative',
                    targetChunkIds: [],
                });
                continue;
            }
            // 非 negative：sourceId 必须 ∈ dump
            const key = lq.sourceId.toLowerCase();
            const chunk = idToChunk.get(key);
            if (!chunk || !validIds.has(key)) {
                stats.droppedInvalidId++;
                continue;
            }
            // 硬门禁 top-5（cross-notebook 带 notebookId 过滤校验）
            const gateNotebookId =
                t === 'cross-notebook' ? note.notebookId ?? undefined : undefined;
            const hits = await searchNotes({
                userId,
                query: lq.query,
                notebookId: gateNotebookId,
                topK: TOP_K_GATE,
            });
            const hit = hits.some((h) => h.chunkId.toLowerCase() === key);
            if (!hit) {
                stats.droppedGate++;
                continue;
            }
            kept.push({
                id: '',
                query: lq.query,
                type: t,
                targetChunkIds: [chunk._id],
                notebookId:
                    t === 'cross-notebook' ? note.notebookId ?? undefined : undefined,
            });
        }
    };

    await runPool(notes, processNote, CONCURRENCY);

    // 不足 TARGET_MIN：补充 pass（重新打乱再跑一轮，靠 LLM 多样性补足）
    if (kept.length < TARGET_MIN) {
        console.warn(
            `⚠️ 首轮仅 ${kept.length} 条 < TARGET_MIN(${TARGET_MIN})，启动补充 pass`,
        );
        const extra = shuffle(notes);
        await runPool(
            extra,
            async (note: NoteGroup) => {
                if (kept.length >= TARGET_MIN) return;
                await processNote(note);
            },
            CONCURRENCY,
        );
    }

    // 类型覆盖兜底：对缺失类型定向补充（每条只生成指定 type）
    const typeCount: Record<string, number> = {};
    for (const k of kept) {
        typeCount[k.type] = (typeCount[k.type] ?? 0) + 1;
    }
    const MIN_PER_TYPE = 2;
    for (const t of TYPE_SET) {
        if ((typeCount[t] ?? 0) >= MIN_PER_TYPE) continue;
        console.warn(`⚠️ 类型 ${t} 不足 ${MIN_PER_TYPE} 条，定向补充`);
        const cand = shuffle(notes);
        for (const note of cand) {
            if ((typeCount[t] ?? 0) >= MIN_PER_TYPE) break;
            const targeted = await callLlm(
                buildSystemPrompt() +
                    `\n本次只生成 1 条 type=${t} 的 query（${t === 'negative' ? 'sourceId 必须为 ""' : 'sourceId 必须 ∈ 所给块'}）。`,
                buildUserPrompt(note),
            );
            for (const lq of targeted) {
                if ((typeCount[t] ?? 0) >= MIN_PER_TYPE) break;
                const lt = lq.type.toLowerCase();
                if (lt !== t) continue;
                if (t === 'negative') {
                    const hits = await searchNotes({
                        userId,
                        query: lq.query,
                        topK: TOP_K_GATE,
                    });
                    if (
                        hits.some(
                            (h) =>
                                idToChunk.get(h.chunkId.toLowerCase())?.noteId ===
                                note.noteId,
                        )
                    ) {
                        continue;
                    }
                    kept.push({
                        id: '',
                        query: lq.query,
                        type: 'negative',
                        targetChunkIds: [],
                    });
                    typeCount.negative = (typeCount.negative ?? 0) + 1;
                } else {
                    const key = lq.sourceId.toLowerCase();
                    const chunk = idToChunk.get(key);
                    if (!chunk) continue;
                    const hit = await searchNotes({
                        userId,
                        query: lq.query,
                        notebookId:
                            t === 'cross-notebook'
                                ? note.notebookId ?? undefined
                                : undefined,
                        topK: TOP_K_GATE,
                    });
                    if (!hit.some((h) => h.chunkId.toLowerCase() === key)) continue;
                    kept.push({
                        id: '',
                        query: lq.query,
                        type: t,
                        targetChunkIds: [chunk._id],
                        notebookId:
                            t === 'cross-notebook'
                                ? note.notebookId ?? undefined
                                : undefined,
                    });
                    typeCount[t] = (typeCount[t] ?? 0) + 1;
                }
            }
        }
    }

    // 赋 id 并截断到 TARGET_MAX
    const finalKept: KeptQuery[] = kept
        .slice(0, TARGET_MAX)
        .map((k, i) => ({ ...k, id: `llm-${String(i + 1).padStart(4, '0')}` }));

    fs.writeFileSync(
        OUT_PATH,
        JSON.stringify(
            {
                schemaVersion: '1.0',
                meta: {
                    generatedBy: 'gen-note-recall-llm',
                    userId,
                    sourceDump: path.basename(DUMP_PATH),
                    generatedAt: new Date().toISOString(),
                    targetMin: TARGET_MIN,
                    targetMax: TARGET_MAX,
                    note: 'LLM 生成的评测数据集，GT 经真实 _id 校验 + searchNotes top-5 硬门禁。',
                },
                queries: finalKept,
            },
            null,
            2,
        ),
        'utf-8',
    );

    // 复核报告
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const keptCount = finalKept.length;
    const passRate =
        stats.generated > 0
            ? (
                  ((keptCount) / stats.generated) *
                  100
              ).toFixed(1)
            : '0';
    const reportPath = path.join(REPORTS_DIR, `note-recall-llm-${date}.md`);
    const L: string[] = [
        '# LLM 评测数据集生成复核报告',
        '',
        `- generatedAt: ${new Date().toISOString()}`,
        `- userId: ${userId}`,
        `- sourceDump: ${path.basename(DUMP_PATH)}`,
        `- child chunks: ${childChunks.length} / notes: ${notes.length}`,
        `- TARGET: ${TARGET_MIN}~${TARGET_MAX}`,
        '',
        '## 产出',
        `- 最终保留：${keptCount} 条`,
        `- LLM 候选总数：${stats.generated}`,
        `- 保留率（保留/候选）：${passRate}%`,
        '',
        '## 丢弃分解',
        `- 非法/编造 _id：${stats.droppedInvalidId}`,
        `- 未过 top-5 硬门禁：${stats.droppedGate}`,
        `- negative 软校验不通过：${stats.droppedNegative}`,
        `- 类型非法：${stats.droppedOther}`,
        '',
        '## 类型分布',
    ];
    for (const t of TYPE_SET) {
        L.push(`- ${t}: ${finalKept.filter((k) => k.type === t).length}`);
    }
    L.push('');
    L.push('> 用 EVAL_DATASET 指向本文件即可评测：');
    L.push(
        `> EVAL_USER_ID=${userId} EVAL_DATASET=${OUT_PATH} pnpm eval:note-recall`,
    );
    fs.writeFileSync(reportPath, L.join('\n'), 'utf-8');

    console.log(`✅ 数据集 → ${OUT_PATH}（${keptCount} 条）`);
    console.log(`✅ 报告 → ${reportPath}`);
    if (keptCount < TARGET_MIN) {
        console.warn(
            `⚠️ 最终 ${keptCount} 条仍 < TARGET_MIN(${TARGET_MIN})，建议放宽 PER_NOTE 或重跑`,
        );
    }
    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch((e: unknown) => {
        console.error(e);
        process.exit(1);
    });
}

/// <reference types="node" />
// scripts/build-note-recall-dataset.ts
// 读取 dump 文件（note-chunks-dump.json）+ 评测 query 模板（note-recall-queries.json），
// 用 jieba 关键词重叠为每条非 negative query 自动匹配候选 NoteChunk.child._id，
// 生成 note-recall-queries.generated.json（可直接喂给 scripts/run-note-recall-eval.ts）。
//
// 用法（项目根目录）：
//   pnpm gen:note-recall-dataset                 # 默认
//   pnpm gen:note-recall-dataset --userId <id>  # 只从指定用户的 chunk 里匹配
//   pnpm gen:note-recall-dataset --topK 5       # 每条 query 取 topK 候选
//
// 说明：
//   - 自动匹配仅为「候选建议」，输出同时生成复核报告（每条 query 的候选与分数）。
//   - 人工复核后才可当作 ground truth；评测时用 EVAL_DATASET 指向生成的文件：
//     EVAL_USER_ID=<id> EVAL_DATASET=tests/evals/datasets/note-recall-queries.generated.json pnpm eval:note-recall
//   - 不写回 note-recall-queries.json，保留手标模板（占位 _id）不被破坏。
import fs from 'fs';
import path from 'path';
import { cut } from 'jieba-wasm';

const DATASET_DIR = path.join(process.cwd(), 'tests/evals/datasets');
const REPORTS_DIR = path.join(process.cwd(), 'tests/evals/reports');

const DUMP_PATH =
    process.env.EVAL_DUMP_PATH ||
    path.join(DATASET_DIR, 'note-chunks-dump.json');
const QUERIES_PATH =
    process.env.EVAL_QUERIES_PATH ||
    path.join(DATASET_DIR, 'note-recall-queries.json');
const GEN_PATH =
    process.env.EVAL_GEN_PATH ||
    path.join(DATASET_DIR, 'note-recall-queries.generated.json');

// 中英文停用词：匹配时这些词不计入关键词，避免噪声
const STOPWORDS = new Set<string>([
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
    '这', '那', '这个', '那个', '这些', '那些', '怎么', '如何', '怎样', '什么',
    '哪些', '为什么', '吗', '呢', '吧', '啊', '呀', '和', '与', '或', '及', '一个',
    '一些', '可以', '需要', '会', '能', '要', '去', '做', '用', '里', '上', '下',
    '中', '从', '到', '把', '被', '让', '给', '而', '但', '如果', '因为', '所以',
    '通过', '对于', '关于', '以及', '比如', '例如', '有没有', '是否', '一款', '一种',
    'the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'how', 'what', 'why',
    'which', 'can', 'will', 'do', 'does', 'did', 'not', 'for', 'in', 'on', 'at',
    'by', 'with', 'from', 'it', 'its', 'this', 'that',
]);

interface DumpChunk {
    _id: string;
    userId: string;
    notebookId: string | null;
    noteId: string | null;
    title: string;
    chunkType: string;
    parentId: string | null;
    sectionPath: string[];
    chunkIndex: number;
    content: string;
    searchText: string;
    contentHash: string;
    updatedAt: string | null;
}

interface QueryEntry {
    id: string;
    query: string;
    targetChunkIds: string[];
    type: string;
    notebookId?: string;
}

function tokenizeQuery(text: string): string[] {
    let words: string[];
    try {
        words = cut(text);
    } catch {
        words = text.split(/\s+/);
    }
    return words
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function scoreChunk(keywords: Set<string>, chunk: DumpChunk): number {
    const hay = (chunk.searchText || chunk.content || '').toLowerCase();
    let score = 0;
    for (const kw of keywords) {
        if (hay.includes(kw)) score++;
    }
    return score;
}

function main(): void {
    if (!fs.existsSync(DUMP_PATH)) {
        console.error(
            `dump 文件不存在：${DUMP_PATH}\n请先跑：pnpm dump:note-chunks --userId <id>`,
        );
        process.exit(1);
    }
    if (!fs.existsSync(QUERIES_PATH)) {
        console.error(`query 模板不存在：${QUERIES_PATH}`);
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
        }, undefined) || process.env.EVAL_USER_ID;

    let chunks = dump.chunks;
    if (userId) chunks = chunks.filter((c) => c.userId === userId);
    const childChunks = chunks.filter((c) => c.chunkType === 'child');

    const topKRaw = (() => {
        const i = process.argv.slice(2).indexOf('--topK');
        return i >= 0 ? Number(process.argv.slice(2)[i + 1]) : NaN;
    })();
    const topK = Number.isInteger(topKRaw) && topKRaw > 0 ? topKRaw : 5;

    const queriesDoc = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf-8')) as {
        schemaVersion?: string;
        meta?: Record<string, unknown>;
        queries: QueryEntry[];
    };
    const queries = queriesDoc.queries;

    const generated: QueryEntry[] = [];
    const review: Array<{
        id: string;
        query: string;
        type: string;
        keywords: string[];
        candidates: Array<{ chunkId: string; title: string; score: number }>;
        confidence: 'high' | 'medium' | 'NONE';
        note?: string;
    }> = [];

    for (const q of queries) {
        if (q.type === 'negative') {
            generated.push({ ...q, targetChunkIds: [] });
            review.push({
                id: q.id,
                query: q.query,
                type: q.type,
                keywords: [],
                candidates: [],
                confidence: 'NONE',
                note: 'negative：保持空 GT（拒绝能力）',
            });
            continue;
        }

        const keywords = new Set(tokenizeQuery(q.query));
        const scored = childChunks
            .map((c) => ({ c, score: scoreChunk(keywords, c) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        const targetIds = scored.map((x) => x.c._id);
        generated.push({ ...q, targetChunkIds: targetIds });

        const confidence: 'high' | 'medium' | 'NONE' =
            scored.length === 0
                ? 'NONE'
                : scored.length >= Math.min(topK, Math.max(1, keywords.size))
                  ? 'high'
                  : 'medium';

        review.push({
            id: q.id,
            query: q.query,
            type: q.type,
            keywords: [...keywords],
            candidates: scored.map((x) => ({
                chunkId: x.c._id,
                title: x.c.title,
                score: x.score,
            })),
            confidence,
            note:
                scored.length === 0
                    ? '⚠️ 无自动匹配，需人工标注'
                    : undefined,
        });
    }

    fs.writeFileSync(
        GEN_PATH,
        JSON.stringify({ ...queriesDoc, queries: generated }, null, 2),
        'utf-8',
    );

    // 复核报告（含候选与分数，供人工判定 ground truth）
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const reviewPath = path.join(
        REPORTS_DIR,
        `note-recall-dataset-build-${date}.md`,
    );
    const L: string[] = [
        '# 数据集生成复核报告',
        '',
        `- generatedAt: ${new Date().toISOString()}`,
        `- userId: ${userId ?? dump.userId ?? 'all'}`,
        `- topK: ${topK}`,
        `- dump child chunks: ${childChunks.length}`,
        `- queries: ${queries.length}`,
        '',
        '> 自动匹配仅为候选建议。confidence=NONE 的 query 必须人工标注后才能当 ground truth。',
        '',
    ];
    for (const r of review) {
        L.push(`## ${r.id} (${r.type}) — ${r.confidence}`);
        L.push(`query: ${r.query}`);
        if (r.keywords.length) L.push(`keywords: ${r.keywords.join(', ')}`);
        if (r.candidates.length === 0) {
            L.push(`⚠️ ${r.note ?? '无自动匹配'}`);
        } else {
            for (const c of r.candidates) {
                L.push(`- [score ${c.score}] ${c.chunkId} — ${c.title}`);
            }
        }
        L.push('');
    }
    fs.writeFileSync(reviewPath, L.join('\n'), 'utf-8');

    console.log(`✅ 生成数据集 → ${GEN_PATH}`);
    console.log(`✅ 复核报告 → ${reviewPath}`);

    const none = review.filter(
        (r) => r.type !== 'negative' && r.candidates.length === 0,
    ).length;
    if (none > 0) {
        console.warn(
            `⚠️ ${none} 条非 negative query 无自动匹配，请人工标注后再评测`,
        );
    } else {
        console.log('全部非 negative query 均找到候选，请复核报告后评测');
    }
}

main();

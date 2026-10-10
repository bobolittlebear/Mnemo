/**
 * M3：ContextBudgeter 单元测试
 *
 * 覆盖：
 * - 纯函数：trimLtmFacts / trimRagChunks 的分数排序 + floor 地板 + 超额逐出
 * - compressMustFit：首尾保留、中间抽取式截断、非破坏、L2c 比 L2a 压得更狠
 * - assembleContext：L0 / L1 / L2c / L3 与「L1 尊重 floor、D3 跌破至 0」四条降级路径
 *
 * 预算可控技巧：注册一个小预算测试模型（inputBudget = 100），
 * 各块用量用可控的 tokenCount / 真实 tokenizer 造出的定长文本，断言到具体数字。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import {
    ContextBudgeter,
    buildSystemPrompt,
} from '@/services/chat/tokenBudget.service';
import type { BudgetBill } from '@/services/chat/tokenBudget.service';
import { BUDGET_CONFIG, MODEL_REGISTRY } from '@/utils/config';
import { countTokens } from '@/utils/tokenizer';
import type { MemorySearchResult } from '@/types/memory';
import type { MemoryFact } from '@/types/models';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import type { RawMessage } from '@/types/chat';

// ── 小预算测试模型：5500 − 400 − margin 5000 = inputBudget 100 ──
const TEST_MODEL = 'test-budget-model';
const BUDGET = 100;

// 模块级登记：describe 体里就要构造 ContextBudgeter，晚于 beforeEach 会拿不到规格
MODEL_REGISTRY[TEST_MODEL] = {
    contextWindow: 10_000,
    maxInputTokens: 5_500,
    maxOutputTokens: 400,
};

afterAll(() => {
    delete MODEL_REGISTRY[TEST_MODEL];
});

/**
 * 造出恰好 n 个 token 的文本（空格分隔的单字母序列，cl100k 下 1 字符 = 1 token）。
 * 使 tokenCount 与 content 严格一致，避免缓存值与文本量对不上导致的假断言。
 */
function T(n: number): string {
    return Array.from({ length: n }, (_, i) =>
        String.fromCharCode(97 + (i % 26)),
    ).join(' ');
}

function rawMsg(
    role: 'user' | 'assistant',
    content: string,
    tokenCount: number,
    msgId = `msg-${role}`,
): RawMessage {
    return { role, content, msgId, timestamp: 1000, tokenCount } as RawMessage;
}

function fact(
    id: string,
    tokenCount: number,
    content = 'x',
    category?: MemoryFact['category'],
): MemoryFact {
    return {
        _id: id,
        content,
        tokenCount,
        confidence: 0.9,
        userId: 'u1',
        sourceMessageIds: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...(category ? { category } : {}),
    } as unknown as MemoryFact;
}

function scored(id: string, rrfScore: number): MemorySearchResult {
    return {
        _id: id,
        content: 'x',
        userId: 'u1',
        confidence: 0.9,
        type: 'fact',
        sourceMessageIds: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        rrfScore,
    } as unknown as MemorySearchResult;
}

function rag(
    chunkId: string,
    score: number,
    content: string,
    parentContext = '',
): NoteRetrievalResult {
    return {
        chunkId,
        noteId: 'n1',
        notebookId: 'nb1',
        title: '标题',
        sectionPath: ['章'],
        chunkIndex: 0,
        content,
        parentContext,
        score,
    };
}

/** 账单里四块用量之和 + 用户消息 = 本轮真实占用（fit 不变量的断言入口） */
function totalOf(bill: BudgetBill, userTokens: number): number {
    return (
        bill.perBlock.system.used +
        bill.perBlock.stm.used +
        bill.perBlock.ltm.used +
        bill.perBlock.rag.used +
        userTokens
    );
}

const ids = <T extends { _id?: unknown }>(list: T[]) =>
    list.map((item) => String(item._id));

// ────────────────────────── trimLtmFacts ──────────────────────────

describe('trimLtmFacts — 按 rrfScore 排序 + floor 地板 + 超额逐出', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);
    const selected = [
        fact('f1', 10),
        fact('f2', 10),
        fact('f3', 10),
        fact('f4', 10),
        fact('f5', 10),
    ];
    // 分数刻意打乱：排序必须由 rrfScore 决定，而不是 selected 的原序
    const candidates = [
        scored('f1', 5),
        scored('f2', 1),
        scored('f3', 4),
        scored('f4', 2),
        scored('f5', 3),
    ];

    it('happy1：预算充足时全量保留，并按 rrfScore 降序重排', () => {
        const kept = budgeter.trimLtmFacts(
            candidates,
            selected,
            BUDGET_CONFIG.ltmFloor,
            Number.POSITIVE_INFINITY,
        );

        expect(ids(kept)).toEqual(['f1', 'f3', 'f5', 'f4', 'f2']);
        expect(kept).toHaveLength(5);
    });

    it('happy2：超额时从低分端逐条逐出，保留高分前 3 条', () => {
        const kept = budgeter.trimLtmFacts(candidates, selected, 2, 30);

        // 5 × 10 token，预算 30 → 逐出 2 条，只留 f1(5) / f3(4) / f5(3)
        expect(ids(kept)).toEqual(['f1', 'f3', 'f5']);
        expect(kept).toHaveLength(3);
    });

    it('边界：L1 地板不可突破——预算只够 1 条时仍保留 top4', () => {
        const kept = budgeter.trimLtmFacts(candidates, selected, 4, 5);

        expect(kept).toHaveLength(4);
        expect(ids(kept)).toEqual(['f1', 'f3', 'f5', 'f4']);
    });

    it('边界：关联不到 rrfScore 的条目得 0 分，排末尾先被裁', () => {
        const kept = budgeter.trimLtmFacts(
            [scored('f1', 5), scored('f3', 4)], // f2/f4/f5 不在候选里
            selected,
            2,
            20,
        );

        // f1(5) → f3(4) → 其余 0 分（保持原序）→ 裁到剩 2 条
        expect(ids(kept)).toEqual(['f1', 'f3']);
    });

    it('category 上限只截断注入副本，库中原文不动（非破坏）', () => {
        const original = fact(
            'f1',
            1000, // content 恰为 1000 token
            T(1000),
            'event', // event 上限 [300, 800]
        );
        const kept = budgeter.trimLtmFacts(
            [scored('f1', 1)],
            [original],
            0,
            Number.POSITIVE_INFINITY,
        );

        const injected = kept[0]!;
        expect(countTokens(injected.content)).toBe(800);
        expect(injected.tokenCount).toBe(800);
        // 原对象与原文一字未改
        expect(injected).not.toBe(original);
        expect(original.content).toBe(T(1000));
        expect(original.tokenCount).toBe(1000);
    });
});

// ────────────────────────── trimRagChunks ──────────────────────────

describe('trimRagChunks — 按 score 排序 + floor 地板 + 超额逐出', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);

    it('happy1：超额时按 score 降序保留，低分端先出', () => {
        const chunks = [
            rag('c1', 8, T(6)),
            rag('c2', 1, T(6)),
            rag('c3', 7, T(6)),
            rag('c4', 2, T(6)),
            rag('c5', 6, T(6)),
            rag('c6', 3, T(6)),
            rag('c7', 5, T(6)),
            rag('c8', 4, T(6)),
        ];

        const kept = budgeter.trimRagChunks(chunks, 5, 30);

        // 8 × 6 token，预算 30 → 恰好保留按分排序的前 5 条
        expect(kept.map((c) => c.chunkId)).toEqual([
            'c1',
            'c3',
            'c5',
            'c7',
            'c8',
        ]);
        expect(kept).toHaveLength(5);
    });

    it('happy2：预算充足时全量保留且按 score 降序（不复制、不改块）', () => {
        const chunks = [rag('c1', 1, T(6)), rag('c2', 9, T(6))];

        const kept = budgeter.trimRagChunks(
            chunks,
            5,
            Number.POSITIVE_INFINITY,
        );

        expect(kept.map((c) => c.chunkId)).toEqual(['c2', 'c1']);
        expect(kept[0]).toBe(chunks[1]);
    });

    it('边界：RAG 地板 top5 不可突破', () => {
        const chunks = Array.from({ length: 8 }, (_, i) =>
            rag(`c${i + 1}`, i, T(6)),
        );

        const kept = budgeter.trimRagChunks(chunks, 5, 6);

        expect(kept).toHaveLength(5);
        expect(kept.map((c) => c.chunkId)).toEqual([
            'c8',
            'c7',
            'c6',
            'c5',
            'c4',
        ]);
    });

    it('边界：父块上下文一并计入注入成本', () => {
        const chunks = [rag('c1', 9, T(6), T(6)), rag('c2', 1, T(6), T(6))];

        // 单块注入成本 = 正文 6 + 父块上下文 6 = 12；预算 12 → 只能留下一条。
        // 若漏算 parentContext（只算 6/块），预算 12 会错误地放下两条。
        const kept = budgeter.trimRagChunks(chunks, 1, 12);

        expect(kept.map((c) => c.chunkId)).toEqual(['c1']);
    });
});

// ────────────────────────── compressMustFit ──────────────────────────

describe('compressMustFit — 抽取式压缩（首尾保留、中间截断、非破坏）', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);

    it('happy：首尾两条原样保留，中间三条按预算均摊截断', () => {
        const messages = Array.from({ length: 5 }, (_, i) =>
            rawMsg('user', T(20), 20, `msg-${i}`),
        );
        // 总 100 token，目标 80：首尾共 40，余 40 均摊给中间 3 条 → 各 13
        const out = budgeter.compressMustFit(messages, 'L2a', 80);

        expect(out[0]!.content).toBe(T(20));
        expect(out[4]!.content).toBe(T(20));
        expect(countTokens(out[1]!.content)).toBe(13);
        expect(countTokens(out[2]!.content)).toBe(13);
        expect(countTokens(out[3]!.content)).toBe(13);

        const total = out.reduce((s, m) => s + m.tokenCount!, 0);
        expect(total).toBe(79);
        expect(total).toBeLessThanOrEqual(80);
    });

    it('边界：非破坏——原数组与元素对象均不被改写', () => {
        const messages = Array.from({ length: 5 }, (_, i) =>
            rawMsg('user', T(20), 20, `msg-${i}`),
        );
        const snapshot = messages.map((m) => m.content);

        const out = budgeter.compressMustFit(messages, 'L2a', 80);

        expect(messages.map((m) => m.content)).toEqual(snapshot);
        expect(messages[1]!.tokenCount).toBe(20);
        expect(out[1]).not.toBe(messages[1]);
    });

    it('边界：预算够用时不做任何截断，仅返回副本', () => {
        const messages = [rawMsg('user', T(10), 10, 'm1')];

        const out = budgeter.compressMustFit(messages, 'L2a', 999);

        expect(out[0]!.content).toBe(T(10));
        expect(out[0]).not.toBe(messages[0]);
    });

    it('边界：L2c 作用于 must-fit，压缩比比 L2a 更狠（0.3 vs 0.5）', () => {
        const messages = Array.from({ length: 5 }, (_, i) =>
            rawMsg('assistant', T(20), 20, `msg-${i}`),
        );

        const l2a = budgeter.compressMustFit(messages, 'L2a');
        const l2c = budgeter.compressMustFit(messages, 'L2c');

        const sum = (list: RawMessage[]) =>
            list.reduce((s, m) => s + m.tokenCount!, 0);
        // L2a：50 token 目标 → 首尾 40 + 中间各 3 = 49
        expect(sum(l2a)).toBe(49);
        // L2c：30 token 目标 → 首尾各被等比缩到 15，中间清空
        expect(sum(l2c)).toBe(30);
        expect(l2c[1]!.content).toBe('');
        expect(sum(l2c)).toBeLessThan(sum(l2a));
    });
});

// ────────────────────────── processSystemPrompt / processUserMessage ──────────────────────────

describe('processSystemPrompt — chat 只观测不裁，write 超限退化', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);

    it('chat：超出 10% 比例上限只记 overBudget，prompt 原样返回', () => {
        const prompt = T(50); // 50 > 100 × 0.1
        const res = budgeter.processSystemPrompt(prompt, 'chat');

        expect(res.tokens).toBe(50);
        expect(res.max).toBe(10);
        expect(res.overBudget).toBe(true);
        expect(res.degraded).toBe(false);
        expect(res.prompt).toBe(prompt);
    });

    it('write：超出模型输入预算时退化为标题 + 首部邻域，不报错', () => {
        const prompt = T(150);
        const res = budgeter.processSystemPrompt(prompt, 'write');

        expect(res.degraded).toBe(true);
        expect(res.tokens).toBe(BUDGET);
        expect(res.prompt).toBe(T(100));
        expect(res.prompt).not.toBe(prompt);
    });

    it('write：未超预算时不退化（即使已超比例上限）', () => {
        const prompt = T(80);
        const res = budgeter.processSystemPrompt(prompt, 'write');

        expect(res.overBudget).toBe(true);
        expect(res.degraded).toBe(false);
        expect(res.prompt).toBe(prompt);
    });
});

describe('processUserMessage — must-fit 不可静默截断', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);

    it('chat：用户消息自身超预算 → 抛中文错误', () => {
        const msg = rawMsg('user', 'q', 101);

        expect(() => budgeter.processUserMessage(msg, 'chat')).toThrow(
            '当前用户消息超出模型输入预算',
        );
    });

    it('边界：write 模式同样超限但不报错（退化由 system 侧承担）', () => {
        const msg = rawMsg('user', 'q', 101);
        const res = budgeter.processUserMessage(msg, 'write');

        expect(res.overBudget).toBe(true);
        expect(res.message).toBe(msg);
    });

    it('happy：未超预算时返回实际计数与 overBudget=false', () => {
        const res = budgeter.processUserMessage(rawMsg('user', 'q', 42));

        expect(res.tokens).toBe(42);
        expect(res.overBudget).toBe(false);
    });
});

// ────────────────────────── assembleContext ──────────────────────────

describe('assembleContext — L0/L1/L2c/L3 降级编排', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);

    it('happy1：D1 全量 fit → L0，各块原样未裁', () => {
        const userMessage = rawMsg('user', 'q', 10, 'msg-u');
        const stm = [
            rawMsg('user', 'hi', 5, 'msg-1'),
            rawMsg('assistant', 'yo', 5, 'msg-2'),
        ];

        const { finalMessages, systemPrompt, bill } = budgeter.assembleContext({
            systemPrompt: '',
            userMessage,
            stmRounds: stm,
            scoredLtm: [scored('f1', 1)],
            selectedLtm: [fact('f1', 20)],
            scoredRag: [rag('c1', 1, 'a')],
        });

        expect(bill.level).toBe('L0');
        expect(bill.inputBudget).toBe(BUDGET);
        expect(bill.mustFitCompressed).toBe(false);
        expect(bill.perBlock).toEqual({
            system: { used: 0, evicted: 0, floor: 0 },
            stm: { used: 10, evicted: 0, floor: 5 },
            ltm: { used: 20, evicted: 0, floor: 4 },
            rag: { used: 1, evicted: 0, floor: 5 },
        });
        expect(totalOf(bill, 10)).toBe(41);
        expect(finalMessages.map((m) => m.msgId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-u',
        ]);
        expect(systemPrompt).toBe('');
    });

    it('happy2：L1 逐出可选块至 floor 后 fit → L1，LTM/RAG 各留地板', () => {
        const userMessage = rawMsg('user', 'q', 10, 'msg-u');
        const stm = [
            rawMsg('user', 'hi', 5, 'msg-1'),
            rawMsg('assistant', 'yo', 5, 'msg-2'),
        ];
        const selectedLtm = Array.from({ length: 5 }, (_, i) =>
            fact(`f${i + 1}`, 12),
        );
        const scoredLtm = selectedLtm.map((f, i) => scored(String(f._id), i));
        const scoredRag = Array.from({ length: 10 }, (_, i) =>
            rag(`c${i + 1}`, i, T(6)),
        );

        const { bill, finalMessages } = budgeter.assembleContext({
            systemPrompt: '',
            userMessage,
            stmRounds: stm,
            scoredLtm,
            selectedLtm,
            scoredRag,
        });

        expect(bill.level).toBe('L1');
        // RAG 先被裁且止步于 floor 5；LTM 随后只让出 1 条
        expect(bill.perBlock.rag).toEqual({ used: 30, evicted: 5, floor: 5 });
        expect(bill.perBlock.ltm).toEqual({ used: 48, evicted: 1, floor: 4 });
        expect(bill.perBlock.stm).toEqual({ used: 10, evicted: 0, floor: 5 });
        expect(totalOf(bill, 10)).toBe(98);
        expect(finalMessages).toHaveLength(3);
    });

    it('边界：D3=否 且 L2a/L2b 均不够 → L2c 临时压缩 must-fitSTM', () => {
        const userMessage = rawMsg('user', 'q', 10, 'msg-u');
        // 6 条 user 消息 × 20 token：最近 5 条为 must-fit，最旧的 1 条为 competitable
        const stm = Array.from({ length: 6 }, (_, i) =>
            rawMsg('user', T(20), 20, `msg-${i}`),
        );

        const { bill, finalMessages } = budgeter.assembleContext({
            systemPrompt: '',
            userMessage,
            stmRounds: stm,
        });

        expect(bill.level).toBe('L2c');
        expect(bill.mustFitCompressed).toBe(true);
        // competitable（1 条）被 L2b 丢弃；must-fit 5 条压缩后共 88
        expect(bill.perBlock.stm.evicted).toBe(1);
        expect(bill.perBlock.stm.used).toBe(88);
        expect(bill.perBlock.ltm.used).toBe(0);
        expect(bill.perBlock.rag.used).toBe(0);
        expect(totalOf(bill, 10)).toBe(98);
        // 首尾两条 must-fit 完整保留，中间三条被压到 16
        expect(finalMessages).toHaveLength(6);
        expect(finalMessages[0]!.content).toBe(T(20));
        expect(countTokens(finalMessages[1]!.content)).toBe(16);
        expect(finalMessages[4]!.content).toBe(T(20));
    });

    it('边界：L1 尊重 floor 不突破，D3=是 时可选块跌破至 0', () => {
        const userMessage = rawMsg('user', 'q', 10, 'msg-u');
        const stm = [
            rawMsg('user', 'hi', 30, 'msg-1'),
            rawMsg('assistant', 'yo', 30, 'msg-2'),
        ];
        const selectedLtm = Array.from({ length: 5 }, (_, i) =>
            fact(`f${i + 1}`, 20),
        );
        const scoredLtm = selectedLtm.map((f, i) => scored(String(f._id), i));
        const scoredRag = Array.from({ length: 6 }, (_, i) =>
            rag(`c${i + 1}`, i, T(6)),
        );

        const { bill } = budgeter.assembleContext({
            systemPrompt: '',
            userMessage,
            stmRounds: stm,
            scoredLtm,
            selectedLtm,
            scoredRag,
        });

        // 核心（system + 用户消息 + 全部 STM）放得下 → 可选块整体清空
        expect(bill.level).toBe('L1');
        expect(bill.perBlock.ltm).toEqual({ used: 0, evicted: 5, floor: 4 });
        expect(bill.perBlock.rag).toEqual({ used: 0, evicted: 6, floor: 5 });
        expect(bill.perBlock.stm.used).toBe(60);
        expect(totalOf(bill, 10)).toBe(70);
    });

    it('边界：system + 用户消息自身超预算 → L3 抛错，不静默截断', () => {
        const systemPrompt = T(60); // 60 token
        const userMessage = rawMsg('user', 'q', 45); // 45 token：自身 ≤ 100，合计 105 > 100

        expect(() =>
            budgeter.assembleContext({ systemPrompt, userMessage }),
        ).toThrow('上下文超出模型输入预算');
    });

    it('边界：写模式超预算不抛错，system 退化为首部邻域副本', () => {
        const systemPrompt = T(150);
        const userMessage = rawMsg('user', 'q', 10);

        const { systemPrompt: finalPrompt, bill } = budgeter.assembleContext({
            systemPrompt,
            userMessage,
            mode: 'write',
        });

        // 退化上限让位给 must-fit 的用户消息：100 − 10 = 90
        expect(finalPrompt).toBe(T(90));
        expect(bill.level).toBe('L0');
        expect(bill.perBlock.system.used).toBe(90);
        expect(totalOf(bill, 10)).toBe(100);
    });

    it('错误处理：chat 模式下 system + 用户消息超预算，不因有可选块可裁而误判可满足', () => {
        // 可选块再大也救不了：裁到 0 后仍只剩超额的 must-fit
        const scoredRag = Array.from({ length: 10 }, (_, i) =>
            rag(`c${i + 1}`, i, T(6)),
        );

        expect(() =>
            budgeter.assembleContext({
                systemPrompt: T(60),
                userMessage: rawMsg('user', 'q', 45),
                scoredRag,
            }),
        ).toThrow('上下文超出模型输入预算');
    });
});

// ────────────────────────── M4：装入块回传 + 渲染 + L3 账单 ──────────────────────────

describe('assembleContext — M4 回传装入块（keptLtm / keptRag）', () => {
    const budgeter = new ContextBudgeter(TEST_MODEL);

    it('happy：L1 逐出后 kept* 与账单条数一致，渲染出的 prompt 不含被逐出的条目', () => {
        const userMessage = rawMsg('user', 'q', 10, 'msg-u');
        const stm = [
            rawMsg('user', 'hi', 5, 'msg-1'),
            rawMsg('assistant', 'yo', 5, 'msg-2'),
        ];
        const selectedLtm = Array.from({ length: 5 }, (_, i) =>
            fact(`f${i + 1}`, 12, `记忆${i + 1}`, 'preference'),
        );
        // f1 分最高 → 逐出从分最低的 f5 开始，便于断言「留下的正好是前 4 条」
        const scoredLtm = selectedLtm.map((f, i) =>
            scored(String(f._id), 5 - i),
        );
        const scoredRag = Array.from({ length: 10 }, (_, i) =>
            rag(`c${i + 1}`, 10 - i, T(6)),
        );

        const { bill, keptLtm, keptRag, systemPrompt } =
            budgeter.assembleContext({
                systemPrompt: '',
                userMessage,
                stmRounds: stm,
                scoredLtm,
                selectedLtm,
                scoredRag,
            });

        // 回传的四条记忆 / 五条笔记必须与账单严格同源
        expect(keptLtm.map((f) => f._id)).toEqual(['f1', 'f2', 'f3', 'f4']);
        expect(bill.perBlock.ltm).toEqual({ used: 48, evicted: 1, floor: 4 });
        expect(keptRag.map((c) => c.chunkId)).toEqual([
            'c1',
            'c2',
            'c3',
            'c4',
            'c5',
        ]);
        expect(bill.perBlock.rag).toEqual({ used: 30, evicted: 5, floor: 5 });

        // 渲染结果即最终 prompt：条数与 kept* 一致，被逐出的不出现
        const prompt = buildSystemPrompt(systemPrompt, keptLtm, keptRag);
        expect(prompt).toContain('<user_memory count="4"');
        expect(prompt).toContain('记忆4');
        expect(prompt).not.toContain('记忆5');
        expect(prompt).toContain('<note_context count="5">');
        expect(prompt.match(/<note /g)).toHaveLength(5);
    });

    it('边界：D3 把可选块降到 0 → kept* 为空，prompt 只剩 base', () => {
        const userMessage = rawMsg('user', 'q', 10, 'msg-u');
        const stm = [
            rawMsg('user', 'hi', 30, 'msg-1'),
            rawMsg('assistant', 'yo', 30, 'msg-2'),
        ];
        const selectedLtm = Array.from({ length: 5 }, (_, i) =>
            fact(`f${i + 1}`, 20, `记忆${i + 1}`),
        );
        const scoredLtm = selectedLtm.map((f, i) => scored(String(f._id), i));
        const scoredRag = Array.from({ length: 6 }, (_, i) =>
            rag(`c${i + 1}`, i, T(6)),
        );

        const { bill, keptLtm, keptRag } = budgeter.assembleContext({
            systemPrompt: '',
            userMessage,
            stmRounds: stm,
            scoredLtm,
            selectedLtm,
            scoredRag,
        });

        expect(bill.perBlock.ltm.used).toBe(0);
        expect(bill.perBlock.rag.used).toBe(0);
        expect(keptLtm).toEqual([]);
        expect(keptRag).toEqual([]);
        expect(buildSystemPrompt('', keptLtm, keptRag)).toBe('');
    });

    it('错误处理：L3 抛错时错误对象带 level 与完整账单', () => {
        const error = (() => {
            try {
                budgeter.assembleContext({
                    systemPrompt: T(60),
                    userMessage: rawMsg('user', 'q', 45),
                });
                return null;
            } catch (e) {
                return e as Error & { level: string; bill: BudgetBill };
            }
        })();

        expect(error?.message).toContain('上下文超出模型输入预算');
        expect(error?.level).toBe('L3');
        expect(error?.bill.level).toBe('L3');
        expect(error?.bill.inputBudget).toBe(BUDGET);
        expect(error?.bill.perBlock).toEqual({
            system: { used: 60, evicted: 0, floor: 0 },
            stm: { used: 0, evicted: 0, floor: 5 },
            ltm: { used: 0, evicted: 0, floor: 4 },
            rag: { used: 0, evicted: 0, floor: 5 },
        });
    });

    it('错误处理：用户消息自身超预算同样带 level/bill（未装配 → 各块 0）', () => {
        const error = (() => {
            try {
                budgeter.assembleContext({
                    systemPrompt: '',
                    userMessage: rawMsg('user', 'q', 101),
                });
                return null;
            } catch (e) {
                return e as Error & { level: string; bill: BudgetBill };
            }
        })();

        expect(error?.message).toContain('当前用户消息超出模型输入预算');
        expect(error?.level).toBe('L3');
        expect(error?.bill.level).toBe('L3');
        expect(error?.bill.perBlock.stm.used).toBe(0);
    });
});

describe('buildSystemPrompt — 裁剪结果 → system prompt（纯函数）', () => {
    function ltm(
        id: string,
        category: string,
        content: string,
        createdAt = new Date('2026-03-04T00:00:00.000Z'),
    ) {
        return { _id: id, content, category, createdAt, tokenCount: 1 };
    }

    it('happy：base / 记忆块 / 笔记块按序拼接，记忆带 category 与 learned 日期', () => {
        const prompt = buildSystemPrompt(
            'BASE 指令',
            [
                ltm('f1', 'preference', '喜欢简洁'),
                ltm('f2', 'goal', '在学 Rust'),
            ],
            [rag('c1', 1, '部署步骤')],
        );

        const expectedDate = new Date().toISOString().slice(0, 10);
        expect(prompt.startsWith('BASE 指令\n\n<memory_instructions>')).toBe(
            true,
        );
        expect(prompt).toContain('<user_memory count="2"');
        expect(prompt).toContain(`retrieved_at="${expectedDate}"`);
        expect(prompt).toContain(
            '<mem category="preference" learned="2026-03-04">喜欢简洁</mem>',
        );
        expect(prompt).toContain(
            '<mem category="goal" learned="2026-03-04">在学 Rust</mem>',
        );
        expect(prompt).toContain('<note_context count="1">');
        expect(prompt).toContain('部署步骤');
        // 记忆块在笔记块之前（先注入记忆再注入笔记）
        expect(prompt.indexOf('<user_memory')).toBeLessThan(
            prompt.indexOf('<note_context'),
        );
    });

    it('边界：三部分全空 → 空串（调用方据此省略 system message）', () => {
        expect(buildSystemPrompt('', [], [])).toBe('');
    });

    it('边界：无记忆时不注入空壳 <user_memory>，只拼存在的部分', () => {
        expect(buildSystemPrompt('BASE', [], [])).toBe('BASE');

        const onlyNotes = buildSystemPrompt('', [], [rag('c1', 1, '正文')]);
        expect(onlyNotes).not.toContain('<memory_instructions>');
        expect(onlyNotes.startsWith('<note_context count="1">')).toBe(true);
    });

    it('边界：转义 & < > " ，记忆正文与笔记正文都不破 XML', () => {
        const prompt = buildSystemPrompt(
            '',
            [ltm('f1', 'other', 'a & b <c> "d"')],
            [rag('c1', 1, '<script>')],
        );

        expect(prompt).toContain(
            '<mem category="other" learned="2026-03-04">a &amp; b &lt;c&gt; &quot;d&quot;</mem>',
        );
        expect(prompt).toContain('&lt;script&gt;');
    });
});

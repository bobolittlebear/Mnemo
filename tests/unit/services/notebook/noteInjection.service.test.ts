/**
 * noteInjection.service.ts 单元测试
 *
 * 测试目标：把 searchNotes 检索结果格式化为 <note_context> XML 块并注入 system prompt，
 * 覆盖降级（检索异常/空 query/无命中）、token 预算控制、顺序、notebookId 透传、原 prompt 不被破坏。
 *
 * Mock 策略：
 * - searchNotes 用 vi.fn() mock，断言真实入参（userId / query / notebookId / topK）
 * - countTokens 用 vi.fn(真实实现) 包装 —— 既可断言入参，又保证预算断言用真实 token 计数（非字符串长度近似）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

vi.mock('@/services/notebook/noteSearch.service', () => ({
    searchNotes: vi.fn(),
}));

// countTokens 保持真实 tiktoken 实现（token 边界断言才有意义），用 vi.fn 包装以便断言调用
vi.mock('@/utils/tokenizer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/tokenizer')>();
    return { ...actual, countTokens: vi.fn(actual.countTokens) };
});

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// getInputBudget 包一层：BUDGET_CONFIG 保持真实，只有「模型输入预算」可被单个用例压低，
// 用来制造 RAG 块超天花板的逐出压力（真实 1M 窗口下永远压不出来）
vi.mock('@/utils/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/config')>();
    return { ...actual, getInputBudget: vi.fn(actual.getInputBudget) };
});

// ── 引入被测模块（在 Mock 之后）──

import {
    injectNotesIntoSystemPrompt,
    buildNoteContextBlock,
} from '@/services/notebook/noteInjection.service';
import { searchNotes } from '@/services/notebook/noteSearch.service';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import { countTokens } from '@/utils/tokenizer';
import { BUDGET_CONFIG, getInputBudget } from '@/utils/config';

// ── 测试工具 ──

const BASE_PROMPT = '你是一个严谨的助手，禁止编造事实。';

function makeResult(
    overrides: Partial<NoteRetrievalResult> = {},
): NoteRetrievalResult {
    return {
        noteId: 'note-A',
        notebookId: '000000000000000000000001',
        title: '部署指南',
        sectionPath: ['部署', '环境配置'],
        chunkIndex: 0,
        content: '部署步骤一',
        parentContext: '',
        score: 0.5,
        ...overrides,
    };
}

/** 从注入后的 systemPrompt 中提取 <note_context> 块 */
function extractNoteContext(systemPrompt: string): string {
    const start = systemPrompt.indexOf('<note_context');
    const end = systemPrompt.indexOf('</note_context>');
    return systemPrompt.slice(start, end + '</note_context>'.length);
}

/** 按出现顺序取出注入块里的 noteId，用于断言保留/逐出了哪几条 */
function noteIdsOf(systemPrompt: string): string[] {
    return Array.from(
        extractNoteContext(systemPrompt).matchAll(/note_id="([^"]+)"/g),
        (m) => m[1]!,
    );
}

// ── 测试 ──

describe('noteInjection.injectNotesIntoSystemPrompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // searchNotes 默认无实现，各用例自行 mockResolvedValue / mockRejectedValue
        vi.mocked(searchNotes).mockReset();
        // 输入预算恢复真实值：只有制造逐出压力的用例才临时压低
        vi.mocked(getInputBudget).mockReturnValue(1_000_000);
    });

    // ────────────────────── Happy Path ──────────────────────

    it('H1: 有匹配笔记 → systemPrompt 含 <note_context> 且含 top1 的 noteId/title/content，原 prompt 完整保留', async () => {
        const top = makeResult({
            noteId: 'note-A',
            title: '部署指南',
            content: '部署步骤一',
            parentContext: '父章节全文',
            score: 0.9,
        });
        const second = makeResult({
            noteId: 'note-B',
            title: 'Docker',
            content: 'docker 安装命令',
            score: 0.3,
        });
        vi.mocked(searchNotes).mockResolvedValue([top, second]);

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
        });

        expect(result).toContain('<note_context');
        expect(result).toContain('note_id="note-A"');
        expect(result).toContain('部署指南'); // title
        expect(result).toContain('部署步骤一'); // content
        expect(result).toContain('父章节全文'); // parent_context
        expect(result).toContain(BASE_PROMPT); // 原 prompt 完整保留

        // 自审：真实入参（topK 默认 12 透传，合并自原 noteSearch / noteInjection 两处 DEFAULT_TOP_K）
        expect(searchNotes).toHaveBeenCalledWith({
            userId: 'u1',
            query: '部署',
            notebookId: undefined,
            topK: 12,
        });
        expect(searchNotes).toHaveBeenCalledTimes(1);
        // 自审（M4）：块成本按「父块正文 + 父块上下文」实时计数——
        // 逐条累加的是这两个字段，而不是渲染后的 <note> 文本
        const tokenArgs = vi.mocked(countTokens).mock.calls.map((c) => c[0]!);
        expect(tokenArgs).toContain('部署步骤一');
        expect(tokenArgs).toContain('父章节全文');
    });

    it('H2: 记忆 + 笔记共存 → <user_memory> 与 <note_context> 同时存在、互不影响', async () => {
        const memoryPrompt = `<memory_instructions>
请基于用户记忆提供个性化回答
</memory_instructions>
<user_memory count="1" retrieved_at="2026-08-19">
<mem category="preference">用户喜欢简洁回答</mem>
</user_memory>`;
        vi.mocked(searchNotes).mockResolvedValue([
            makeResult({ noteId: 'note-A', content: '部署步骤一' }),
        ]);

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: memoryPrompt,
        });

        expect(result).toContain('<user_memory');
        expect(result).toContain('<mem category="preference">');
        expect(result).toContain('<note_context');
        // 笔记块追加在记忆块之后
        expect(result.indexOf('<user_memory')).toBeLessThan(
            result.indexOf('<note_context'),
        );
    });

    // ────────────────────── 降级 ──────────────────────

    it('E1: searchNotes 抛错 → 返回原 systemPrompt，不向测试层抛错，命中降级分支', async () => {
        vi.mocked(searchNotes).mockRejectedValue(
            new Error('Embedding API 限流'),
        );

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
        });

        expect(result).toBe(BASE_PROMPT);
        expect(result).not.toContain('<note_context');
        expect(searchNotes).toHaveBeenCalledTimes(1);
        expect(countTokens).not.toHaveBeenCalled(); // 降级分支不再走预算逻辑
    });

    it('E2: searchNotes 返回 [] → 返回原 systemPrompt，不含 <note_context>', async () => {
        vi.mocked(searchNotes).mockResolvedValue([]);

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '无匹配词',
            systemPrompt: BASE_PROMPT,
        });

        expect(result).toBe(BASE_PROMPT);
        expect(result).not.toContain('<note_context');
        expect(countTokens).not.toHaveBeenCalled();
    });

    it('E3: query 为空 / 纯空白 → 不调用 searchNotes，直接返回原 prompt', async () => {
        const r1 = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '',
            systemPrompt: BASE_PROMPT,
        });
        const r2 = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '   ',
            systemPrompt: BASE_PROMPT,
        });

        expect(r1).toBe(BASE_PROMPT);
        expect(r2).toBe(BASE_PROMPT);
        expect(searchNotes).not.toHaveBeenCalled();
        expect(countTokens).not.toHaveBeenCalled();
    });

    // ────────────────────── token 预算 ──────────────────────

    it('B1a: 固定 1500 token 预算已移除 → 预算宽裕时召回几条注入几条', async () => {
        // 7 条召回（约 70+ token）：旧实现会被 1500 预算或 8 条上限之外的逻辑截断，
        // M4 起只在超「模型输入预算 × ragMaxRatio」天花板时才逐出
        const results = Array.from({ length: 7 }, (_, i) =>
            makeResult({
                noteId: `note-${i + 1}`,
                content: `第 ${i + 1} 段正文`,
                score: 0.9 - i * 0.1,
            }),
        );
        vi.mocked(searchNotes).mockResolvedValue(results);

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
        });

        const keptIds = noteIdsOf(result);
        expect(keptIds).toHaveLength(7);
        expect(keptIds).toContain('note-7');
        expect(countTokens).toHaveBeenCalled();
    });

    it('B1b: 预算吃紧（超块天花板）→ 从低分端逐出，止步于 ragFloor', async () => {
        // 天花板 = inputBudget × ragMaxRatio：把输入预算压到 40 → 天花板 10 token，
        // 7 条均超 → 逐出至 floor(5)，且留下的必是分数最高的 5 条
        vi.mocked(getInputBudget).mockReturnValue(40);
        const results = Array.from({ length: 7 }, (_, i) =>
            makeResult({
                noteId: `note-${i + 1}`,
                content: `第 ${i + 1} 段正文`,
                score: 0.9 - i * 0.1,
            }),
        );
        vi.mocked(searchNotes).mockResolvedValue(results);

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
        });

        // floor 只是下限：压到 5 条即停，不会更狠
        expect(noteIdsOf(result)).toEqual([
            'note-1',
            'note-2',
            'note-3',
            'note-4',
            'note-5',
        ]);
        expect(noteIdsOf(result)).toHaveLength(BUDGET_CONFIG.ragFloor);
        expect(result).not.toContain('note_id="note-6"');
        expect(result).not.toContain('note_id="note-7"');
    });

    it('B2: 多 note 顺序 → 即使 searchNotes 未按分数排序，注入块内按融合分降序', async () => {
        const a = makeResult({ noteId: 'note-A', score: 0.3 });
        const b = makeResult({ noteId: 'note-B', score: 0.9 });
        vi.mocked(searchNotes).mockResolvedValue([a, b]); // 返回顺序 A 在前，B 分更高

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
        });

        expect(result.indexOf('note_id="note-B"')).toBeLessThan(
            result.indexOf('note_id="note-A"'),
        );
    });

    // ────────────────────── 透传与保护 ──────────────────────

    it('N1: notebookId / topK 透传给 searchNotes', async () => {
        vi.mocked(searchNotes).mockResolvedValue([makeResult()]);

        await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
            notebookId: 'nb-1',
            topK: 4,
        });

        expect(searchNotes).toHaveBeenCalledWith({
            userId: 'u1',
            query: '部署',
            notebookId: 'nb-1',
            topK: 4,
        });
    });

    it('P1: 注入后原 systemPrompt 的指令文本完整存在且位于头部，不被改写', async () => {
        vi.mocked(searchNotes).mockResolvedValue([makeResult()]);

        const result = await injectNotesIntoSystemPrompt({
            userId: 'u1',
            query: '部署',
            systemPrompt: BASE_PROMPT,
        });

        expect(result.startsWith(BASE_PROMPT)).toBe(true);
        expect(result).toContain(`\n\n<note_context`);
    });
});

// ────────────────────── 纯函数 buildNoteContextBlock ──────────────────────

describe('noteInjection.buildNoteContextBlock', () => {
    it('T1: XML 转义（& < > "）与 section 用 `>` 连接', () => {
        const note = makeResult({
            noteId: 'a&b',
            title: '标题<A>',
            content: '内容 "X" & <Y>',
            sectionPath: ['部署', 'A>B'],
        });

        const block = buildNoteContextBlock([note]);

        expect(block).toContain('note_id="a&amp;b"');
        expect(block).toContain('title="标题&lt;A&gt;"');
        expect(block).toContain('section="部署 &gt; A&gt;B"');
        expect(block).toContain(
            '<content>内容 &quot;X&quot; &amp; &lt;Y&gt;</content>',
        );
        expect(block.startsWith('<note_context count="1">')).toBe(true);
        expect(block.endsWith('</note_context>')).toBe(true);
    });

    it('T2: parent_context 为空时省略该元素，存在时包含', () => {
        const without = buildNoteContextBlock([
            makeResult({ parentContext: '' }),
        ]);
        expect(without).not.toContain('<parent_context>');

        const withParent = buildNoteContextBlock([
            makeResult({ parentContext: '父章节全文' }),
        ]);
        expect(withParent).toContain(
            '<parent_context>父章节全文</parent_context>',
        );
    });

    it('T3: 空结果集返回空串', () => {
        expect(buildNoteContextBlock([])).toBe('');
    });
});

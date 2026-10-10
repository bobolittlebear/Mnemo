/**
 * M4：ContextBudgeter 接入 chatStream 装配链（集成单测）
 *
 * 验收标准：
 * - 三条检索（STM / LTM / RAG）之后、createStreamChat 之前完成预算裁剪，
 *   下发给模型的消息与 systemPrompt 都是裁过的
 * - systemPrompt 由 buildSystemPrompt 渲染，且用的是预算器**实际装入**的 LTM / RAG
 *   （账单与提示词同源：L1/D3 把可选块裁到 0 时，prompt 里也不该再有记忆/笔记）
 * - 召回结果（scoredLtm / scoredRag）作为原始输入喂给预算器，bill 由此记账
 * - bill 经 logger.info('token budget bill') 落计量（W3 软闸：只观测不强裁）
 * - 预算不可满足 → 抛错且错误上带 level / bill（L3）
 * - 写模式同样纳入预算：笔记全文超限退化为「标题 + 首部邻域」，不报错
 * - 全程 mock：不起网络、不调真实 LLM / Mongo / Redis；仅 RAG 预算器与其计数是真实实现
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

const {
    createMock,
    loggerMock,
    sessionMock,
    redisMock,
    chatMessageMock,
    persistWriteRoundMock,
    persistToolResultMock,
} = vi.hoisted(() => ({
    createMock: vi.fn(),
    loggerMock: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    sessionMock: { findOne: vi.fn(), updateOne: vi.fn(), create: vi.fn() },
    redisMock: { set: vi.fn(), get: vi.fn() },
    chatMessageMock: { insertMany: vi.fn(), trimOldMessages: vi.fn() },
    persistWriteRoundMock: vi.fn(),
    persistToolResultMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => loggerMock }));

vi.mock('@/lib/redis', () => ({ default: redisMock }));

vi.mock('@/models/Session', () => ({ default: sessionMock }));

vi.mock('@/models/ChatMessage', () => ({ default: chatMessageMock }));

vi.mock('@/services/core/llm', () => ({
    getAIApi: () => ({ chat: { completions: { create: createMock } } }),
}));

vi.mock('@/services/memory', () => ({
    messageCounter: { record: vi.fn() },
    sessionMemoryLifecycle: {
        resetForContinuation: vi.fn(),
        touch: vi.fn(),
    },
}));

vi.mock('@/utils/shortTermMemory', () => ({
    default: {
        safeGetRecentRounds: vi.fn(),
        clearSession: vi.fn(),
        addMessages: vi.fn(),
    },
}));

vi.mock('@/services/memory/memorySearch.service', () => ({
    default: { search: vi.fn() },
}));

vi.mock('@/services/memory/memorySelection.service', () => ({
    default: { select: vi.fn() },
}));

vi.mock('@/services/notebook/noteInjection.service', () => ({
    injectNotesIntoSystemPrompt: vi.fn(),
    retrieveNotes: vi.fn(),
}));

vi.mock('@/services/chat/writeModeContext.service', () => ({
    persistWriteRound: persistWriteRoundMock,
    persistToolResult: persistToolResultMock,
}));

// 只有「模型输入预算」可被单个用例压低：真实 1M 窗口下压不出降级，
// 而 L1/L2c/L3 正是本文件要验证的分支
vi.mock('@/utils/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/config')>();
    return { ...actual, getInputBudget: vi.fn(actual.getInputBudget) };
});

import chatStreamService from '@/services/chat/chatStream.service';
import STM from '@/utils/shortTermMemory';
import { sessionMemoryLifecycle } from '@/services/memory';
import memorySearchService from '@/services/memory/memorySearch.service';
import memorySelectionService from '@/services/memory/memorySelection.service';
import { retrieveNotes } from '@/services/notebook/noteInjection.service';
import { getInputBudget } from '@/utils/config';
import { countTokens } from '@/utils/tokenizer';
import type { RawMessage } from '@/types/chat';
import type { MemorySearchResult } from '@/types/memory';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import type { BudgetExceededError } from '@/services/chat/tokenBudget.service';

// ── 测试辅助 ──

/**
 * 造「恰好 n 个 token」的文本（单字母词表，cl100k 下一个字母即一个 token）。
 * 预算断言要的是精确整数，不能用字符串长度近似。
 */
function T(n: number): string {
    return Array.from({ length: n }, (_, i) =>
        String.fromCharCode(97 + (i % 26)),
    ).join(' ');
}

function chunk(
    delta: { content?: string },
    finishReason?: string,
): ChatCompletionChunk {
    return {
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    } as unknown as ChatCompletionChunk;
}

function streamOf(chunks: ChatCompletionChunk[]) {
    return (async function* () {
        for (const c of chunks) yield c;
    })();
}

/** STM 的一轮历史（tokenCount 显式给出，模拟落库缓存的计数） */
function stmRound(
    content: string,
    tokenCount: number,
    msgId: string,
    role: 'user' | 'assistant' = 'user',
): RawMessage {
    return { role, content, msgId, timestamp: 1, tokenCount } as RawMessage;
}

/** 检索命中的记忆（带瞬时 rrfScore） */
function mem(
    id: string,
    rrfScore: number,
    content: string,
    category: string,
): MemorySearchResult {
    return {
        _id: id,
        content,
        userId: 'u1',
        confidence: 1,
        category,
        type: 'fact',
        sourceMessageIds: [],
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
        rrfScore,
    };
}

/** 检索命中的笔记块（content 计 6 token，parentContext 计 4） */
function rag(id: string, score: number): NoteRetrievalResult {
    return {
        chunkId: `chunk-${id}`,
        noteId: id,
        notebookId: 'nb-1',
        title: `标题${id}`,
        sectionPath: ['部署'],
        chunkIndex: 0,
        content: T(6),
        parentContext: T(4),
        score,
    };
}

type StreamChatProps = Parameters<typeof chatStreamService.streamChat>[0];

function streamChatProps(
    userContent: string,
    overrides: Partial<StreamChatProps> = {},
): StreamChatProps {
    return {
        sessionId: 'sess-1',
        userId: 'u1',
        messages: [
            { role: 'user', content: userContent, msgId: 'msg-u' },
        ] as StreamChatProps['messages'],
        traceId: 'trace-1',
        onChunk: vi.fn(),
        ...overrides,
    };
}

/** persistConversation 的 Mongo 写入在 setImmediate 里，等它跑完再看断言 */
const flushSetImmediate = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 下发模型的请求参数。
 * systemPrompt 由真实 ai.service 前置成 messages[0]，故这里从消息里反读，
 * 断言的就是模型**实际看到**的 system 文本。
 */
function request(): {
    messages: Array<{ role: string; content: string }>;
    systemPrompt?: string;
} {
    const params = createMock.mock.calls[0]![0] as {
        messages: Array<{ role: string; content: string }>;
    };
    const first = params.messages[0];
    return {
        messages: params.messages,
        systemPrompt: first?.role === 'system' ? first.content : undefined,
    };
}

const REAL_BUDGET = 1_000_000;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInputBudget).mockReturnValue(REAL_BUDGET);
    vi.mocked(sessionMemoryLifecycle.resetForContinuation).mockResolvedValue(
        false,
    );
    vi.mocked(STM.safeGetRecentRounds).mockResolvedValue([]);
    vi.mocked(memorySearchService.search).mockResolvedValue({
        results: [],
    } as never);
    vi.mocked(memorySelectionService.select).mockResolvedValue({
        selected: [],
        metadata: {},
    } as never);
    vi.mocked(retrieveNotes).mockResolvedValue([]);
    sessionMock.findOne.mockResolvedValue({ status: 'active' });
    sessionMock.updateOne.mockResolvedValue({});
    redisMock.set.mockResolvedValue('OK');
    chatMessageMock.insertMany.mockResolvedValue([]);
    chatMessageMock.trimOldMessages.mockResolvedValue(undefined);
    persistWriteRoundMock.mockResolvedValue(undefined);
    createMock.mockResolvedValue(
        streamOf([chunk({ content: '收到' }, 'stop')]),
    );
});

// ────────────────────────── happy path ──────────────────────────

describe('chatStream × ContextBudgeter 装配', () => {
    it('happy1：预算宽裕（L0）→ 记忆与笔记都进 systemPrompt，账单落计量', async () => {
        vi.mocked(STM.safeGetRecentRounds).mockResolvedValue([
            stmRound('历史一', 10, 'msg-1'),
            stmRound('历史二', 10, 'msg-2', 'assistant'),
        ]);
        const scored = [
            mem('f1', 9, T(10), 'cat-1'),
            mem('f2', 5, T(12), 'cat-2'),
        ];
        vi.mocked(memorySearchService.search).mockResolvedValue({
            results: scored,
        } as never);
        vi.mocked(memorySelectionService.select).mockResolvedValue({
            selected: scored,
            metadata: {
                totalCandidates: 2,
                afterPercentile: 2,
                afterDedup: 2,
            },
        } as never);
        vi.mocked(retrieveNotes).mockResolvedValue([
            rag('n-1', 0.9),
            rag('n-2', 0.4),
        ]);

        await chatStreamService.streamChat(streamChatProps(T(5)));
        await flushSetImmediate();

        // 1. 检索入参：预算器拿到的必须是原始召回结果（否则 bill 无源可记）
        expect(retrieveNotes).toHaveBeenCalledWith({
            userId: 'u1',
            query: T(5),
        });
        expect(memorySearchService.search).toHaveBeenCalledWith({
            userId: 'u1',
            query: T(5),
        });

        // 2. 消息 = 历史（带 tokenCount）+ 本轮用户消息
        const req = request();
        expect(req.messages.map((m) => m.role)).toEqual([
            'system',
            'user',
            'assistant',
            'user',
        ]);
        expect(req.messages[3]!.content).toBe(T(5));

        // 3. systemPrompt：记忆块在前、笔记块在后，且都是预算器装入的那一份
        const prompt = req.systemPrompt!;
        expect(prompt).toContain('<memory_instructions>');
        expect(prompt).toContain('<user_memory count="2"');
        expect(prompt).toContain('<mem category="cat-1"');
        expect(prompt).toContain('<mem category="cat-2"');
        expect(prompt).toContain('<note_context count="2">');
        expect(prompt).toContain('note_id="n-1"');
        expect(prompt).toContain('note_id="n-2"');
        expect(prompt.indexOf('<user_memory')).toBeLessThan(
            prompt.indexOf('<note_context'),
        );

        // 4. 账单：L0 全量装配，各块用量为真实 token 数
        expect(loggerMock.info).toHaveBeenCalledWith(
            'token budget bill',
            expect.objectContaining({
                sessionId: 'sess-1',
                inputBudget: REAL_BUDGET,
                level: 'L0',
                mustFitCompressed: false,
                perBlock: {
                    system: { used: 0, evicted: 0, floor: 0 },
                    stm: { used: 20, evicted: 0, floor: 5 },
                    ltm: { used: 22, evicted: 0, floor: 4 },
                    rag: { used: 20, evicted: 0, floor: 5 },
                },
                duration_ms: expect.any(Number),
            }),
        );
    });

    it('happy2：L1 逐出后装配 → prompt 只剩装入的那几条，与账单逐条对齐', async () => {
        // 预算 115。各块记账：user 5 + STM 20 + LTM 6×10 + RAG 8×(6+4)
        // L0 = 165 放不下 → 逐出 RAG 到 floor 5（50）仍 135 → 再逐出 LTM 到 floor 4（40）
        // → 5+20+40+50 = 115，正好 fit
        vi.mocked(getInputBudget).mockReturnValue(115);
        vi.mocked(STM.safeGetRecentRounds).mockResolvedValue([
            stmRound('历史一', 10, 'msg-1'),
            stmRound('历史二', 10, 'msg-2', 'assistant'),
        ]);
        const scored = Array.from({ length: 6 }, (_, i) =>
            mem(`f${i + 1}`, 9 - i, T(10), `cat-${i + 1}`),
        );
        vi.mocked(memorySearchService.search).mockResolvedValue({
            results: scored,
        } as never);
        vi.mocked(memorySelectionService.select).mockResolvedValue({
            selected: scored,
            metadata: { totalCandidates: 6, afterPercentile: 6, afterDedup: 6 },
        } as never);
        vi.mocked(retrieveNotes).mockResolvedValue(
            Array.from({ length: 8 }, (_, i) => rag(`n-${i + 1}`, 1 - i / 10)),
        );

        await chatStreamService.streamChat(streamChatProps(T(5)));
        await flushSetImmediate();

        const prompt = request().systemPrompt!;
        // 高分的 4 条记忆 / 5 条笔记留下，低分端被逐出（且 prompt 里不再出现）
        expect(prompt).toContain('<user_memory count="4"');
        expect(prompt).toContain('cat-4');
        expect(prompt).not.toContain('cat-5');
        expect(prompt).not.toContain('cat-6');
        expect(prompt).toContain('<note_context count="5">');
        expect(prompt).toContain('note_id="n-5"');
        expect(prompt).not.toContain('note_id="n-6"');
        expect(prompt).not.toContain('note_id="n-8"');

        expect(loggerMock.info).toHaveBeenCalledWith(
            'token budget bill',
            expect.objectContaining({
                level: 'L1',
                mustFitCompressed: false,
                perBlock: {
                    system: { used: 0, evicted: 0, floor: 0 },
                    stm: { used: 20, evicted: 0, floor: 5 },
                    ltm: { used: 40, evicted: 2, floor: 4 },
                    rag: { used: 50, evicted: 3, floor: 5 },
                },
            }),
        );
        // STM 未受牵连：历史两条原样进模型（加 system 共 4 条）
        expect(request().messages).toHaveLength(4);
    });

    it('边界：D3=否 → L2c 临时压缩 must-fit，可选块整体清空', async () => {
        // 预算 100：6 条 STM（各 20）+ user 10 → 核心 130 放不下；
        // 可选块裁到 0 后 must-fit（100）仍放不下 → L2c 压缩成 88
        vi.mocked(getInputBudget).mockReturnValue(100);
        vi.mocked(STM.safeGetRecentRounds).mockResolvedValue(
            Array.from({ length: 6 }, (_, i) =>
                stmRound(T(20), 20, `msg-${i + 1}`),
            ),
        );
        vi.mocked(memorySearchService.search).mockResolvedValue({
            results: [mem('f1', 9, T(10), 'cat-1')],
        } as never);
        vi.mocked(memorySelectionService.select).mockResolvedValue({
            selected: [mem('f1', 9, T(10), 'cat-1')],
            metadata: { totalCandidates: 1, afterPercentile: 1, afterDedup: 1 },
        } as never);
        vi.mocked(retrieveNotes).mockResolvedValue([rag('n-1', 0.9)]);

        await chatStreamService.streamChat(streamChatProps(T(10)));
        await flushSetImmediate();

        const req = request();
        // 可选块清空 → 没有 systemPrompt（空串按缺省处理，不前置 system 消息）
        expect(req.systemPrompt).toBeUndefined();
        expect(req.messages[0]!.role).toBe('user');
        // competitable 1 条被丢，must-fit 5 条压缩后进模型：首尾完整、中间被截
        expect(req.messages).toHaveLength(6);
        expect(req.messages[0]!.content).toBe(T(20));
        expect(countTokens(req.messages[1]!.content)).toBe(16);
        expect(req.messages[4]!.content).toBe(T(20));
        expect(req.messages[5]!.content).toBe(T(10));

        expect(loggerMock.info).toHaveBeenCalledWith(
            'token budget bill',
            expect.objectContaining({
                level: 'L2c',
                mustFitCompressed: true,
                perBlock: {
                    system: { used: 0, evicted: 0, floor: 0 },
                    stm: { used: 88, evicted: 1, floor: 5 },
                    ltm: { used: 0, evicted: 1, floor: 4 },
                    rag: { used: 0, evicted: 1, floor: 5 },
                },
            }),
        );
    });

    it('错误处理：预算不可满足 → 抛错且错误带 level/bill（L3），不静默截断用户原话', async () => {
        vi.mocked(getInputBudget).mockReturnValue(20);
        const props = streamChatProps(T(30));

        const error = (await chatStreamService
            .streamChat(props)
            .then(() => null)
            .catch((e: unknown) => e)) as BudgetExceededError;

        expect(error.message).toContain('超出模型输入预算');
        expect(error.level).toBe('L3');
        expect(error.bill.level).toBe('L3');
        expect(error.bill.inputBudget).toBe(20);
        // 没装配成功就不该发起任何模型请求
        expect(createMock).not.toHaveBeenCalled();
    });

    it('写模式：笔记全文超模型输入上限 → 退化为首部邻域后仍发起请求，不报错', async () => {
        // 写模式 system 就是笔记全文本体；退化上限让位给 must-fit 的用户消息：100 − 10 = 90
        vi.mocked(getInputBudget).mockReturnValue(100);
        await chatStreamService.streamChat(
            streamChatProps(T(10), {
                mode: 'write',
                noteId: 'note-1',
                runId: 'run-1',
                writeContext: {
                    messages: [
                        { role: 'user', content: T(10), msgId: 'msg-u' },
                    ] as RawMessage[],
                    systemPrompt: T(150),
                },
            }),
        );
        await flushSetImmediate();

        const req = request();
        // 退化副本进请求：system 消息 = 笔记全文的前 90 token，用户消息未被裁
        expect(req.systemPrompt).toBe(T(90));
        expect(req.messages[0]!.role).toBe('system');
        expect(req.messages[1]!.content).toBe(T(10));

        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.stringContaining('写模式'),
            expect.objectContaining({
                tokens: 150,
                cap: 90,
                degradedTokens: 90,
            }),
        );
        // 写模式同样落账单：system 块按退化后的实际用量记账
        expect(loggerMock.info).toHaveBeenCalledWith(
            'token budget bill',
            expect.objectContaining({
                sessionId: 'sess-1',
                mode: 'write',
                level: 'L0',
                perBlock: {
                    system: { used: 90, evicted: 0, floor: 0 },
                    stm: { used: 0, evicted: 0, floor: 5 },
                    ltm: { used: 0, evicted: 0, floor: 4 },
                    rag: { used: 0, evicted: 0, floor: 5 },
                },
            }),
        );
    });
});

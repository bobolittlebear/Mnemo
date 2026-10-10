/**
 * M2：消息落库的 tokenCount 计数（单元测试）
 *
 * 验收标准：
 * - STM（Redis payload）与 ChatMessage（Mongo）两处写同一条消息时，
 *   tokenCount 一致，且等于 countTokens(content)
 * - content 为空串时 tokenCount 为 0（countTokens 的安全兜底）
 * - 空白 assistant 回复不落库 → 不产生任何 tokenCount 写入
 * - 全程 mock：不起网络、不调真实 LLM / Mongo / Redis
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
    retrieveNotes: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/services/chat/writeModeContext.service', () => ({
    persistWriteRound: persistWriteRoundMock,
    persistToolResult: persistToolResultMock,
}));

import chatStreamService from '@/services/chat/chatStream.service';
import STM from '@/utils/shortTermMemory';
import { sessionMemoryLifecycle } from '@/services/memory';
import memorySearchService from '@/services/memory/memorySearch.service';
import memorySelectionService from '@/services/memory/memorySelection.service';
import { injectNotesIntoSystemPrompt } from '@/services/notebook/noteInjection.service';
import { countTokens } from '@/utils/tokenizer';
import type { RawMessage } from '@/types/chat';

// ── 测试辅助 ──

function chunk(
    delta: { content?: string; tool_calls?: unknown[] },
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

type StreamChatProps = Parameters<typeof chatStreamService.streamChat>[0];

function streamChatProps(
    userContent: string,
    overrides: Partial<StreamChatProps> = {},
): StreamChatProps {
    return {
        sessionId: 'sess-1',
        userId: 'u1',
        messages: [
            { role: 'user', content: userContent, msgId: 'msg-1' },
        ] as StreamChatProps['messages'],
        traceId: 'trace-1',
        runId: 'run-1',
        onChunk: vi.fn(),
        ...overrides,
    };
}

/** persistConversation 的 Mongo 写入在 setImmediate 里，等它跑完再看断言 */
const flushSetImmediate = () => new Promise((resolve) => setImmediate(resolve));

const USER_TEXT = '帮我写一段前言';
const ASSISTANT_TEXT = '好的，这是前言内容。';

/** 取本轮 STM 写入的 payload 数组 */
function stmDocs(): Partial<RawMessage>[] {
    return vi.mocked(STM.addMessages).mock.calls[0]![1] as Partial<RawMessage>[];
}

/** 取本轮 Mongo 写入的文档数组 */
function mongoDocs(): Array<Record<string, unknown>> {
    return chatMessageMock.insertMany.mock.calls[0]![0] as Array<
        Record<string, unknown>
    >;
}

beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(injectNotesIntoSystemPrompt).mockResolvedValue('');
    sessionMock.findOne.mockResolvedValue({ status: 'active' });
    sessionMock.updateOne.mockResolvedValue({});
    redisMock.set.mockResolvedValue('OK');
    chatMessageMock.insertMany.mockResolvedValue([]);
    chatMessageMock.trimOldMessages.mockResolvedValue(undefined);
    persistWriteRoundMock.mockResolvedValue(undefined);
});

describe('消息落库 tokenCount', () => {
    it('happy1：STM payload 与 Mongo 文档都带 tokenCount，等于 countTokens(content)', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: ASSISTANT_TEXT }, 'stop')]),
        );

        await chatStreamService.streamChat(streamChatProps(USER_TEXT));
        await flushSetImmediate();

        const expectedUser = countTokens(USER_TEXT);
        const expectedAssistant = countTokens(ASSISTANT_TEXT);
        // 前置：非空文本必然计数为正，否则断言退化为 0 === 0
        expect(expectedUser).toBeGreaterThan(0);
        expect(expectedAssistant).toBeGreaterThan(0);

        const stm = stmDocs();
        expect(stm).toHaveLength(2);
        expect(stm[0]!.role).toBe('user');
        expect(stm[0]!.content).toBe(USER_TEXT);
        expect(stm[0]!.tokenCount).toBe(expectedUser);
        expect(stm[1]!.role).toBe('assistant');
        expect(stm[1]!.content).toBe(ASSISTANT_TEXT);
        expect(stm[1]!.tokenCount).toBe(expectedAssistant);

        const docs = mongoDocs();
        expect(docs).toHaveLength(2);
        expect(docs[0]!.tokenCount).toBe(expectedUser);
        expect(docs[1]!.tokenCount).toBe(expectedAssistant);
    });

    it('happy2：写模式回复轮同样带 tokenCount（STM 与 Mongo 一致）', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: ASSISTANT_TEXT }, 'stop')]),
        );

        await chatStreamService.streamChat(
            streamChatProps(USER_TEXT, { mode: 'write', noteId: 'note-1' }),
        );
        await flushSetImmediate();

        const docs = mongoDocs();
        expect(docs).toHaveLength(2);
        expect(docs[0]!.tokenCount).toBe(countTokens(USER_TEXT));
        expect(docs[1]!.tokenCount).toBe(countTokens(ASSISTANT_TEXT));
        // 上下文域标签与 tokenCount 共存，互不覆盖
        expect(docs[1]!.mode).toBe('write');
        expect(docs[1]!.noteId).toBe('note-1');
        expect(docs[1]!.runId).toBe('run-1');
    });

    it('边界1：用户 content 为空串时 tokenCount 为 0，不落 undefined', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: ASSISTANT_TEXT }, 'stop')]),
        );

        await chatStreamService.streamChat(streamChatProps(''));
        await flushSetImmediate();

        expect(countTokens('')).toBe(0);

        const stm = stmDocs();
        expect(stm[0]!.content).toBe('');
        expect(stm[0]!.tokenCount).toBe(0);

        const docs = mongoDocs();
        expect(docs[0]!.content).toBe('');
        expect(docs[0]!.tokenCount).toBe(0);
    });

    it('边界2：assistant 只有空白 → 整轮不落库，两处都不产生 tokenCount', async () => {
        createMock.mockResolvedValue(streamOf([chunk({ content: '   ' }, 'stop')]));

        await chatStreamService.streamChat(streamChatProps(USER_TEXT));
        await flushSetImmediate();

        expect(STM.addMessages).not.toHaveBeenCalled();
        expect(chatMessageMock.insertMany).not.toHaveBeenCalled();
    });
});

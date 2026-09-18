/**
 * M-C1：streamChat 的写模式持久化分派（单元测试）
 *
 * 验收标准：
 * - 写模式工具轮 → persistWriteRound（落 user + assistant(toolCalls)，不写 STM）
 * - 写模式工具轮缺 noteId → 告警跳过，不落游离消息
 * - 写模式回复轮 → 仍走 persistConversation（STM/LTM 链路不断），但 Mongo 侧带 mode/noteId/runId
 * - chat 模式落库形状零变化（回归保护）
 * - 落库失败不炸掉已结束的流
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

// 拦截 SDK 客户端：流由每个用例注入
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
}));

// 只桩掉落库函数，保留 streamChat 真实实现（本文件测的就是它的分派）
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

// ── 测试辅助 ──

/** 构造单个 chunk（只造被测路径需要的字段） */
function chunk(
    delta: { content?: string; tool_calls?: unknown[] },
    finishReason?: string,
): ChatCompletionChunk {
    return {
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    } as unknown as ChatCompletionChunk;
}

/** 按顺序吐出给定 chunk 的流 */
function streamOf(chunks: ChatCompletionChunk[]) {
    return (async function* () {
        for (const c of chunks) yield c;
    })();
}

/** 一个工具轮的 chunk 序列：首帧带 id/name，中帧增量 args，末帧 tool_calls 终止 */
function toolCallStream() {
    return streamOf([
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: 'call_xxx',
                    type: 'function',
                    function: { name: 'insert_at_cursor', arguments: '' },
                },
            ],
        }),
        chunk({
            tool_calls: [
                { index: 0, function: { arguments: '{"markdown":"# 标题"}' } },
            ],
        }),
        chunk({}, 'tool_calls'),
    ]);
}

type StreamChatProps = Parameters<typeof chatStreamService.streamChat>[0];

function streamChatProps(
    overrides: Partial<StreamChatProps> = {},
): StreamChatProps {
    return {
        sessionId: 'sess-1',
        userId: 'u1',
        messages: [
            { role: 'user', content: '帮我写一段', msgId: 'msg-1' },
        ] as StreamChatProps['messages'],
        traceId: 'trace-1',
        runId: 'run-1',
        onChunk: vi.fn(),
        ...overrides,
    };
}

/** persistConversation 的 Mongo 写入在 setImmediate 里，等它跑完再看断言 */
const flushSetImmediate = () => new Promise((resolve) => setImmediate(resolve));

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

describe('写模式工具轮 — 落库分派', () => {
    it('happy1：走 persistWriteRound，带 noteId/runId 与结构化 toolCalls，不写 Mongo 常规链路', async () => {
        createMock.mockResolvedValue(toolCallStream());
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            streamChatProps({
                mode: 'write',
                noteId: 'note-1',
                onToolCall,
                onRunPaused,
            }),
        );

        expect(persistWriteRoundMock).toHaveBeenCalledTimes(1);
        const arg = persistWriteRoundMock.mock.calls[0]![0];
        expect(arg.sessionId).toBe('sess-1');
        expect(arg.userId).toBe('u1');
        expect(arg.noteId).toBe('note-1');
        expect(arg.runId).toBe('run-1');
        expect(arg.traceId).toBe('trace-1');
        expect(arg.userMsg.content).toBe('帮我写一段');
        expect(arg.userMsg.msgId).toBe('msg-1');
        // assistant 无正文（工具轮），msgId 由 service 生成
        expect(arg.assistantMsg.content).toBe('');
        expect(arg.assistantMsg.msgId).toMatch(/^msg-/);
        // 存储侧保留结构化参数（不是 JSON 字符串）
        expect(arg.toolCalls).toEqual([
            {
                id: 'call_xxx',
                name: 'insert_at_cursor',
                arguments: { markdown: '# 标题' },
            },
        ]);
        // 工具轮不落 STM，也不走常规 Mongo 链路
        expect(STM.addMessages).not.toHaveBeenCalled();
        expect(chatMessageMock.insertMany).not.toHaveBeenCalled();
        // 事件发射不受落库影响
        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onRunPaused).toHaveBeenCalledTimes(1);
    });

    it('边界1：缺 noteId 时告警跳过，不落游离消息', async () => {
        createMock.mockResolvedValue(toolCallStream());

        await chatStreamService.streamChat(
            streamChatProps({ mode: 'write', onRunPaused: vi.fn() }),
        );

        expect(persistWriteRoundMock).not.toHaveBeenCalled();
        expect(chatMessageMock.insertMany).not.toHaveBeenCalled();
        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写模式工具轮缺少 noteId，本轮不落库',
            expect.objectContaining({ sessionId: 'sess-1', runId: 'run-1' }),
        );
    });

    it('边界2：落库抛错只告警，不炸掉已暂停的流', async () => {
        createMock.mockResolvedValue(toolCallStream());
        persistWriteRoundMock.mockRejectedValue(new Error('mongo down'));

        await expect(
            chatStreamService.streamChat(
                streamChatProps({
                    mode: 'write',
                    noteId: 'note-1',
                    onRunPaused: vi.fn(),
                }),
            ),
        ).resolves.toBeUndefined();

        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写模式工具轮落库失败',
            expect.objectContaining({
                component: 'mongodb',
                noteId: 'note-1',
                error: expect.any(Error),
            }),
        );
    });

    it('chat 模式即使拼出 tool_calls 也不走写模式落库', async () => {
        createMock.mockResolvedValue(toolCallStream());

        await chatStreamService.streamChat(
            streamChatProps({ mode: 'chat', onRunPaused: vi.fn() }),
        );

        expect(persistWriteRoundMock).not.toHaveBeenCalled();
    });
});

describe('写模式回复轮 — 上下文域标签', () => {
    it('happy2：仍走 persistConversation，Mongo 两条消息带 mode/noteId/runId', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: '已经写好了' }, 'stop')]),
        );

        await chatStreamService.streamChat(
            streamChatProps({ mode: 'write', noteId: 'note-1' }),
        );
        await flushSetImmediate();

        // STM 链路保留（LTM 提取的数据源）
        expect(STM.addMessages).toHaveBeenCalledTimes(1);
        expect(persistWriteRoundMock).not.toHaveBeenCalled();

        expect(chatMessageMock.insertMany).toHaveBeenCalledTimes(1);
        const [docs] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(docs).toHaveLength(2);
        for (const doc of docs) {
            expect(doc.mode).toBe('write');
            expect(doc.noteId).toBe('note-1');
            expect(doc.runId).toBe('run-1');
            expect(doc.sessionId).toBe('sess-1');
        }
        expect(docs[1]!.content).toBe('已经写好了');
    });

    it('边界3：chat 模式落库形状不变（不带上下文域标签）', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: '你好' }, 'stop')]),
        );

        await chatStreamService.streamChat(streamChatProps({ mode: 'chat' }));
        await flushSetImmediate();

        const [docs] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(docs).toHaveLength(2);
        for (const doc of docs) {
            expect('mode' in doc).toBe(false);
            expect('noteId' in doc).toBe(false);
            expect('runId' in doc).toBe(false);
        }
    });
});

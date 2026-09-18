/**
 * M-C3：streamChat 的写模式预装配上下文覆盖（单元测试）
 *
 * 验收标准：
 * - 传 writeContext 且 mode='write' → 采用预装配的 messages/systemPrompt，
 *   跳过 STM 检索 / 记忆检索 / 笔记 RAG 三条默认装配路径
 * - 工具轮回调与落库：续轮（messages 为空）不把历史末位的 tool 消息当 user 落库
 * - 续轮回复轮：只落 assistant（设计 §3.4：一个 run 只有一个用户轮）
 * - 传了 writeContext 但 mode!=='write' → 忽略，走默认装配
 * - 全程 mock：不起网络、不调真实 LLM / Mongo / Redis
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { RawMessage } from '@/types/chat';

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

// 拦截 SDK 客户端：断言"送进模型请求的东西"（system 前置由 ai.service 完成）
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

// 只桩掉落库函数，保留 streamChat 真实实现
vi.mock('@/services/chat/writeModeContext.service', () => ({
    persistWriteRound: persistWriteRoundMock,
    persistToolResult: persistToolResultMock,
}));

import chatStreamService from '@/services/chat/chatStream.service';
import { chatTools } from '@/services/chat/tools';
import STM from '@/utils/shortTermMemory';
import { sessionMemoryLifecycle } from '@/services/memory';
import memorySearchService from '@/services/memory/memorySearch.service';
import memorySelectionService from '@/services/memory/memorySelection.service';
import { injectNotesIntoSystemPrompt } from '@/services/notebook/noteInjection.service';

// ── 测试辅助 ──

type StreamChatProps = Parameters<typeof chatStreamService.streamChat>[0];

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

/** 一个工具轮的 chunk 序列：首帧带 id/name，末帧 tool_calls 终止 */
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

/** 装配层给出的历史（写模式从 MongoDB 全量取，末位通常是 tool 消息） */
const historyToolMsg: RawMessage = {
    role: 'tool',
    content: '{"status":"applied"}',
    msgId: 'msg-tool',
    timestamp: 2,
} as RawMessage;

const historyUserMsg: RawMessage = {
    role: 'user',
    content: '帮我写一段',
    msgId: 'msg-user',
    timestamp: 1,
} as RawMessage;

/** 续轮形态的 props：messages 为空，历史全在 writeContext 内 */
function renewProps(overrides: Partial<StreamChatProps> = {}): StreamChatProps {
    return {
        sessionId: 'sess-1',
        userId: 'u1',
        messages: [],
        traceId: 'trace-1',
        mode: 'write',
        runId: 'run-1',
        noteId: 'note-1',
        writeContext: {
            messages: [historyUserMsg, historyToolMsg],
            systemPrompt: 'SYS',
        },
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
    persistToolResultMock.mockResolvedValue(undefined);
});

describe('写模式预装配上下文 — 覆盖默认装配', () => {
    it('happy1：writeContext 的 systemPrompt/历史进模型请求，默认装配三件套全部跳过', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: '已经写好了' }, 'stop')]),
        );
        const onChunk = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            renewProps({ onChunk, onRunPaused }),
        );
        // 本轮也会落库（回复轮），必须在本用例内跑完 setImmediate，
        // 否则写入会漂到下一个用例里（clearAllMocks 清不掉已排期的回调）
        await flushSetImmediate();

        // system 前置由 ai.service 完成：写模式 prompt 必须排在消息首位
        const request = createMock.mock.calls[0]![0];
        expect(request.messages[0]).toEqual({
            role: 'system',
            content: 'SYS',
        });
        expect(request.messages[1]).toEqual(historyUserMsg);
        expect(request.messages[2]).toEqual(historyToolMsg);
        expect(request.messages).toHaveLength(3);
        // 写模式才注入工具定义
        expect(request.tools).toBe(chatTools);

        // 默认装配路径（STM / 记忆 / 笔记 RAG）一律不碰
        expect(STM.safeGetRecentRounds).not.toHaveBeenCalled();
        expect(memorySearchService.search).not.toHaveBeenCalled();
        expect(injectNotesIntoSystemPrompt).not.toHaveBeenCalled();

        // delta 正常回调，回复轮不声明 run_paused
        expect(onChunk).toHaveBeenCalledWith('已经写好了');
        expect(onRunPaused).not.toHaveBeenCalled();
    });

    it('happy2：工具轮回调 tool_call + run_paused，userMsg 为 undefined（不冒充 user 落库）', async () => {
        createMock.mockResolvedValue(toolCallStream());
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            renewProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0]![0].function.name).toBe(
            'insert_at_cursor',
        );
        expect(onRunPaused).toHaveBeenCalledTimes(1);

        expect(persistWriteRoundMock).toHaveBeenCalledTimes(1);
        const arg = persistWriteRoundMock.mock.calls[0]![0];
        expect(arg.sessionId).toBe('sess-1');
        expect(arg.noteId).toBe('note-1');
        expect(arg.runId).toBe('run-1');
        // 续轮 Request 的 messages 为空：历史末位的 tool 消息不得被当成 user 落库
        expect(arg.userMsg).toBeUndefined();
    });

    it('happy3：续轮回复轮只落 assistant（一个 run 只有一个用户轮），STM 同步单条', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: '已按要求写入' }, 'stop')]),
        );

        await chatStreamService.streamChat(renewProps());
        await flushSetImmediate();

        const [docs] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(docs).toHaveLength(1);
        expect(docs[0].role).toBe('assistant');
        expect(docs[0].content).toBe('已按要求写入');
        expect(docs[0].mode).toBe('write');
        expect(docs[0].noteId).toBe('note-1');
        expect(docs[0].runId).toBe('run-1');

        const [, stmDocs] = vi.mocked(STM.addMessages).mock.calls[0]!;
        expect(stmDocs).toHaveLength(1);
        expect(stmDocs[0]!.role).toBe('assistant');
    });

    it('边界1：传了 writeContext 但 mode!=="write" → 忽略，走默认装配（STM 被调用）', async () => {
        createMock.mockResolvedValue(
            streamOf([chunk({ content: '你好' }, 'stop')]),
        );

        await chatStreamService.streamChat(
            renewProps({ mode: 'chat', messages: [historyUserMsg] }),
        );

        // 预装配被忽略：STM 检索照常发生，且不注入工具
        expect(STM.safeGetRecentRounds).toHaveBeenCalledTimes(1);
        const request = createMock.mock.calls[0]![0];
        expect(request.messages).toEqual([historyUserMsg]);
        expect(request.tools).toBeUndefined();
        // 预装配的 systemPrompt 也不得渗进 chat 模式
        expect(request.messages[0].role).not.toBe('system');
    });

    it('边界2：工具轮落库抛错只告警，不炸掉已暂停的流', async () => {
        createMock.mockResolvedValue(toolCallStream());
        persistWriteRoundMock.mockRejectedValue(new Error('mongo down'));

        await expect(
            chatStreamService.streamChat(renewProps({ onRunPaused: vi.fn() })),
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
});

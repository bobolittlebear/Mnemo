/**
 * 写作模式工具名白名单（P0 后端硬拦截，单元测试）
 *
 * 背景：写作模式下 LLM 会幻觉出不存在的工具（如 read_file / edit）并触发工具轮。
 * 本层在工具累积收尾处加白名单：只认 chatTools 里定义的工具名，未列出的直接丢弃——
 * 不下发 onToolCall、不声明 run_paused、不落写模式工具历史，本轮降级为普通文本回复。
 *
 * 验收标准：
 * - 白名单内工具（update_title / insert_at_cursor / replace_selection）行为不变
 * - 纯幻觉轮：全部丢弃 → onToolCall / onRunPaused 均不触发，走普通文本落库
 * - 混合轮（合法 + 幻觉）：只保留合法工具，幻觉不影响本轮的正常收尾
 * - 畸形 tool_call（name 缺失）与未列出的名字同等处理
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

// 只桩掉落库函数，保留 streamChat 真实实现（本文件测的就是它的收尾判定）
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

type ToolCallDelta = {
    index: number;
    id?: string | null;
    type?: string;
    function?: { name?: string; arguments?: string };
};

/** 一个工具轮的 chunk 序列：首帧带 id/name，中帧增量 args，末帧 tool_calls 终止 */
function toolRound(
    calls: Array<{ index: number; id?: string; name?: string; args: string }>,
    textBefore = '',
): ChatCompletionChunk[] {
    const chunks: ChatCompletionChunk[] = [];
    if (textBefore) {
        chunks.push(chunk({ content: textBefore }));
    }
    for (const call of calls) {
        chunks.push(
            chunk({
                tool_calls: [
                    {
                        index: call.index,
                        ...(call.id ? { id: call.id } : {}),
                        type: 'function',
                        ...(call.name !== undefined
                            ? { function: { name: call.name, arguments: '' } }
                            : { function: { arguments: '' } }),
                    },
                ],
            }),
        );
        chunks.push(
            chunk({
                tool_calls: [
                    { index: call.index, function: { arguments: call.args } },
                ],
            }),
        );
    }
    chunks.push(chunk({}, 'tool_calls'));
    return chunks;
}

function chunk(
    delta: { content?: string; tool_calls?: ToolCallDelta[] },
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
        // 白名单只在写模式工具轮语境下有意义，故默认按写模式注入完整上下文域
        mode: 'write',
        noteId: 'note-1',
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

describe('写作模式工具名白名单', () => {
    it('happy1：白名单内工具 insert_at_cursor 照常下发并落库', async () => {
        createMock.mockResolvedValue(
            streamOf(
                toolRound([
                    {
                        index: 0,
                        id: 'call_xxx',
                        name: 'insert_at_cursor',
                        args: '{"markdown":"# 标题"}',
                    },
                ]),
            ),
        );
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0]![0].function.name).toBe(
            'insert_at_cursor',
        );
        expect(onRunPaused).toHaveBeenCalledTimes(1);
        expect(persistWriteRoundMock).toHaveBeenCalledTimes(1);
        const arg = persistWriteRoundMock.mock.calls[0]![0];
        expect(arg.toolCalls).toHaveLength(1);
        expect(arg.toolCalls[0]!.name).toBe('insert_at_cursor');
    });

    it('happy2：白名单内工具 update_title 的 name 原样落入拼接结果', async () => {
        createMock.mockResolvedValue(
            streamOf(
                toolRound([
                    {
                        index: 0,
                        id: 'call_title',
                        name: 'update_title',
                        args: '{"new_title":"X"}',
                    },
                ]),
            ),
        );
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0]![0]).toEqual({
            id: 'call_title',
            type: 'function',
            function: {
                name: 'update_title',
                arguments: { new_title: 'X' },
            },
        });
        expect(onRunPaused).toHaveBeenCalledTimes(1);
        expect(persistWriteRoundMock.mock.calls[0]![0].toolCalls[0]!.name).toBe(
            'update_title',
        );
    });

    it('边界1：幻觉工具 read_file 被丢弃，降级为普通文本回复', async () => {
        createMock.mockResolvedValue(
            streamOf(
                toolRound(
                    [
                        {
                            index: 0,
                            id: 'call_hallucinated',
                            name: 'read_file',
                            args: '{"path":"/etc/hosts"}',
                        },
                    ],
                    '我先看看文件内容',
                ),
            ),
        );
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );
        await flushSetImmediate();

        // 未授权工具不执行、不声明暂停、不落工具历史
        expect(onToolCall).not.toHaveBeenCalled();
        expect(onRunPaused).not.toHaveBeenCalled();
        expect(persistWriteRoundMock).not.toHaveBeenCalled();
        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写作模式收到未授权工具名，已丢弃',
            expect.objectContaining({
                traceId: 'trace-1',
                toolName: 'read_file',
            }),
        );

        // 正文非空 → 落到既有普通文本分支（写模式仍带上下文域标签）
        expect(STM.addMessages).toHaveBeenCalledTimes(1);
        expect(chatMessageMock.insertMany).toHaveBeenCalledTimes(1);
        const [docs] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(docs).toHaveLength(2);
        expect(docs[0]!.content).toBe('帮我写一段');
        expect(docs[1]!.content).toBe('我先看看文件内容');
        expect(docs[1]!.mode).toBe('write');
        expect(docs[1]!.noteId).toBe('note-1');
        expect('toolCalls' in docs[1]!).toBe(false);
    });

    it('边界2：合法与幻觉并存时只保留合法工具', async () => {
        createMock.mockResolvedValue(
            streamOf(
                toolRound([
                    {
                        index: 0,
                        id: 'call_ok',
                        name: 'insert_at_cursor',
                        args: '{"markdown":"Y"}',
                    },
                    {
                        index: 1,
                        id: 'call_bad',
                        name: 'edit',
                        args: '{"file":"a.md"}',
                    },
                ]),
            ),
        );
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0]![0].function.name).toBe(
            'insert_at_cursor',
        );
        // 混合轮仍是工具轮：正常 onRunPaused + 落库，且只落合法工具
        expect(onRunPaused).toHaveBeenCalledTimes(1);
        expect(persistWriteRoundMock).toHaveBeenCalledTimes(1);
        const arg = persistWriteRoundMock.mock.calls[0]![0];
        expect(arg.toolCalls).toHaveLength(1);
        expect(arg.toolCalls[0]!.id).toBe('call_ok');
        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写作模式收到未授权工具名，已丢弃',
            expect.objectContaining({ toolName: 'edit' }),
        );
    });

    it('边界3：畸形 tool_call（name 缺失）视为未授权跳过', async () => {
        createMock.mockResolvedValue(
            streamOf(
                toolRound([
                    { index: 0, id: 'call_malformed', args: '{"x":"y"}' },
                ]),
            ),
        );
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).not.toHaveBeenCalled();
        expect(onRunPaused).not.toHaveBeenCalled();
        expect(persistWriteRoundMock).not.toHaveBeenCalled();
        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写作模式收到未授权工具名，已丢弃',
            expect.objectContaining({ toolName: '' }),
        );
    });

    it('自审：拼接结果的形状被快照固化', async () => {
        createMock.mockResolvedValue(
            streamOf(
                toolRound([
                    {
                        index: 0,
                        id: 'call_xxx',
                        name: 'insert_at_cursor',
                        args: '{"markdown":"# 标题"}',
                    },
                ]),
            ),
        );
        const onToolCall = vi.fn();

        await chatStreamService.streamChat(streamChatProps({ onToolCall }));

        expect(onToolCall.mock.calls.map(([tc]) => tc)).toMatchSnapshot();
    });
});

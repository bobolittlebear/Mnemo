/**
 * M-B1b：tool_calls 流式拼接 + tool_call / run_paused 事件发射（单元测试）
 *
 * 依据 M-B1a 实测的真实 chunk 格式：
 * - 首帧：带 id(call_xxx) / type:'function' / function.name，arguments 为空
 * - 中帧：只增量追加 function.arguments（JSON 字符串片段）
 * - 末帧：{ function: { arguments: '' }, index: 0, id: null, type: 'function' } 终止帧
 *
 * 验收标准：
 * - 按 index 归并（不写死 0），终止帧的 null/空串不得清掉已拼好的 id 与参数
 * - arguments 拼接后 JSON.parse；解析失败回退原串 + 告警，整轮不崩
 * - 工具轮发射 tool_call + run_paused，且不补 done；普通回复轮行为不变
 * - 只测"拼接与事件发射"，不碰持久化 / continue 端点 / 下一轮装配（属 M-C1 / M-C3）
 * - 全程 mock，不起真实网络、不调真实 LLM
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

// ── Mock 外部依赖（hoisted，供 vi.mock 工厂引用）──
const { createMock, loggerMock, sessionMock, redisMock, chatMessageMock } =
    vi.hoisted(() => ({
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
    }));

vi.mock('@/lib/logger', () => ({
    createLogger: () => loggerMock,
}));

vi.mock('@/lib/redis', () => ({ default: redisMock }));

vi.mock('@/models/Session', () => ({ default: sessionMock }));

vi.mock('@/models/ChatMessage', () => ({ default: chatMessageMock }));

// 拦截 SDK 客户端：流由每个用例注入
vi.mock('@/services/core/llm', () => ({
    getAIApi: () => ({ chat: { completions: { create: createMock } } }),
}));

// 默认委托真实实现（服务层用例需要真拼接），
// 同时是 spy，供 controller 用例替换成"只回调不跑流"的桩
vi.mock('@/services/chat/chatStream.service', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('@/services/chat/chatStream.service')
        >();
    return {
        default: {
            streamChat: vi.fn(actual.default.streamChat.bind(actual.default)),
        },
    };
});

// 组合根在 import 时即启动后台扫描器，必须整体 mock 掉
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

import chatStreamService from '@/services/chat/chatStream.service';
import { chat } from '@/controllers/chat.controller';
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

type Delta = { content?: string; tool_calls?: ToolCallDelta[] };

/** 构造单个 chunk（真实 chunk 字段远多于此，只造被测路径需要的） */
function chunk(delta: Delta, finishReason?: string): ChatCompletionChunk {
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
            { role: 'user', content: '把标题改成 X', msgId: 'msg-1' },
        ] as StreamChatProps['messages'],
        traceId: 'trace-1',
        runId: 'run-1',
        onChunk: vi.fn(),
        ...overrides,
    };
}

/**
 * 构造最小合规的 req/res，收集所有 SSE 写出内容
 *
 * M-C2 起上下文域（mode/noteId/runId）由中间件统一注入 req.meta，
 * 控制器不再读 body——故这些字段经第二个参数（meta）注入；
 * 传空对象即模拟"中间件未注入上下文域"（chat 模式默认形态）。
 */
function makeReqRes(
    body: Record<string, unknown>,
    meta: Record<string, unknown> = { sessionId: 'sess-1' },
) {
    const writes: string[] = [];
    const res = {
        locals: { traceId: 'trace-1' },
        headersSent: false,
        setHeader: vi.fn(),
        write: vi.fn((frame: string) => {
            writes.push(frame);
            return true;
        }),
        end: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    const req = {
        body,
        user: { userId: 'u1' },
        meta,
    };

    return {
        req: req as unknown as Parameters<typeof chat>[0],
        res: res as unknown as Parameters<typeof chat>[1],
        writes,
    };
}

/** 从写出的 SSE 帧里取某事件的 data（缺失返回 null） */
function sseData(writes: string[], event: string): unknown {
    const frame = writes.find((w) => w.startsWith(`event: ${event}\n`));

    return frame ? JSON.parse(frame.split('data: ')[1]!.trim()) : null;
}

/**
 * vi.clearAllMocks() 只清调用记录，不清 mockImplementation——
 * 控制器用例换过的桩会泄漏给后续用例，故每次都用真实实现覆盖回来。
 */
const realStreamChat = vi
    .mocked(chatStreamService.streamChat)
    .getMockImplementation();

beforeEach(() => {
    vi.clearAllMocks();
    if (realStreamChat) {
        vi.mocked(chatStreamService.streamChat).mockImplementation(
            realStreamChat,
        );
    }
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
    sessionMock.create.mockResolvedValue({});
    redisMock.set.mockResolvedValue('OK');
    chatMessageMock.insertMany.mockResolvedValue([]);
});

describe('tool_calls 拼接', () => {
    it('happy1：按实测格式拼出完整工具调用', async () => {
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        createMock.mockResolvedValue(
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'call_xxx',
                            type: 'function',
                            function: {
                                name: 'insert_at_cursor',
                                arguments: '',
                            },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            function: { arguments: '{"markdown":"# 标' },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [{ index: 0, function: { arguments: '题"}' } }],
                }),
                // 终止帧：id 为 null、arguments 为空串，不得覆盖已累积值
                chunk(
                    {
                        tool_calls: [
                            {
                                index: 0,
                                id: null,
                                type: 'function',
                                function: { arguments: '' },
                            },
                        ],
                    },
                    'tool_calls',
                ),
            ]),
        );

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).toHaveBeenCalledTimes(1);
        const tc = onToolCall.mock.calls[0]![0];
        expect(tc.id).toBe('call_xxx');
        expect(tc.type).toBe('function');
        expect(tc.function.name).toBe('insert_at_cursor');
        expect(tc.function.arguments).toEqual({ markdown: '# 标题' });
        expect(onRunPaused).toHaveBeenCalledTimes(1);
        // 先发 tool_call 再声明 run_paused
        expect(onToolCall.mock.invocationCallOrder[0]).toBeLessThan(
            onRunPaused.mock.invocationCallOrder[0]!,
        );
    });

    it('边界1：arguments 非合法 JSON 时回退原串并告警，整轮不崩', async () => {
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();

        createMock.mockResolvedValue(
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'update_title', arguments: '' },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [
                        { index: 0, function: { arguments: 'not-json' } },
                    ],
                }),
                chunk({}, 'tool_calls'),
            ]),
        );

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused }),
        );

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0]![0].function.arguments).toBe(
            'not-json',
        );
        expect(loggerMock.warn).toHaveBeenCalledWith(
            'tool_call arguments 非合法 JSON，回退原串',
            expect.objectContaining({ index: 0, arguments: 'not-json' }),
        );
        // 解析失败不影响本轮终态声明
        expect(onRunPaused).toHaveBeenCalledTimes(1);
    });

    it('边界2：多工具按 index 归并，各自独立累积', async () => {
        const onToolCall = vi.fn();

        createMock.mockResolvedValue(
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'call_a',
                            type: 'function',
                            function: { name: 'update_title', arguments: '' },
                        },
                        {
                            index: 1,
                            id: 'call_b',
                            type: 'function',
                            function: {
                                name: 'insert_at_cursor',
                                arguments: '',
                            },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            function: { arguments: '{"new_title":"X"}' },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [
                        {
                            index: 1,
                            function: { arguments: '{"markdown":"Y"}' },
                        },
                    ],
                }),
                chunk({}, 'tool_calls'),
            ]),
        );

        await chatStreamService.streamChat(streamChatProps({ onToolCall }));

        expect(onToolCall).toHaveBeenCalledTimes(2);
        expect(
            onToolCall.mock.calls.map(([tc]) => [
                tc.id,
                tc.function.name,
                tc.function.arguments,
            ]),
        ).toEqual([
            ['call_a', 'update_title', { new_title: 'X' }],
            ['call_b', 'insert_at_cursor', { markdown: 'Y' }],
        ]);
    });

    it('边界4：空 arguments 解析失败但降级为空串，不抛错', async () => {
        const onToolCall = vi.fn();

        createMock.mockResolvedValue(
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'update_title', arguments: '' },
                        },
                    ],
                }),
                chunk({}, 'tool_calls'),
            ]),
        );

        await expect(
            chatStreamService.streamChat(streamChatProps({ onToolCall })),
        ).resolves.toBeUndefined();

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0]![0].function.arguments).toBe('');
    });

    it('缺少 id 时降级为 call_{index}，不产出空 id', async () => {
        const onToolCall = vi.fn();

        createMock.mockResolvedValue(
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 3,
                            type: 'function',
                            function: {
                                name: 'replace_selection',
                                arguments: '{"markdown":"Z"}',
                            },
                        },
                    ],
                }),
                chunk({}, 'tool_calls'),
            ]),
        );

        await chatStreamService.streamChat(streamChatProps({ onToolCall }));

        expect(onToolCall.mock.calls[0]![0].id).toBe('call_3');
        // 不作为并行支持的旁证：key 用的是 chunk 自带的 index，不是数组下标
        expect(onToolCall.mock.calls[0]![0].function.name).toBe(
            'replace_selection',
        );
    });

    it('边界3：普通回复轮不触发任何工具回调', async () => {
        const onToolCall = vi.fn();
        const onRunPaused = vi.fn();
        const onChunk = vi.fn();

        createMock.mockResolvedValue(
            streamOf([
                chunk({ content: '你好' }),
                chunk({ content: '，世界' }, 'stop'),
            ]),
        );

        await chatStreamService.streamChat(
            streamChatProps({ onToolCall, onRunPaused, onChunk }),
        );

        expect(onToolCall).not.toHaveBeenCalled();
        expect(onRunPaused).not.toHaveBeenCalled();
        // 既有文本路径不受影响
        expect(onChunk.mock.calls.map(([c]) => c)).toEqual(['你好', '，世界']);
    });
});

describe('chat 控制器 — 事件发射接线', () => {
    it('happy2：工具轮写 tool_call + run_paused，且不写 done', async () => {
        vi.mocked(chatStreamService.streamChat).mockImplementation(
            async (props) => {
                props.onToolCall?.({
                    id: 'call_xxx',
                    type: 'function',
                    function: {
                        name: 'insert_at_cursor',
                        arguments: { markdown: '# 标题' },
                    },
                });
                props.onRunPaused?.();
            },
        );

        const { req, res, writes } = makeReqRes(
            { messages: [{ role: 'user', content: '帮我写', msgId: 'm1' }] },
            { sessionId: 'sess-1', mode: 'write', runId: 'run-1' },
        );

        await chat(req, res);

        expect(sseData(writes, 'tool_call')).toEqual({
            runId: 'run-1',
            toolCallId: 'call_xxx',
            tool: 'insert_at_cursor',
            args: { markdown: '# 标题' },
        });
        expect(sseData(writes, 'run_paused')).toEqual({
            runId: 'run-1',
            reason: 'waiting_client_execution',
        });
        expect(writes.filter((w) => w.includes('[DONE]'))).toEqual([]);
    });

    it('meta 无 runId → 控制器不再兜底 mint，入参与事件保持一致（均无值）', async () => {
        vi.mocked(chatStreamService.streamChat).mockImplementation(
            async (props) => {
                props.onRunPaused?.();
            },
        );

        const { req, res, writes } = makeReqRes({
            messages: [{ role: 'user', content: '帮我写', msgId: 'm1' }],
        });

        await chat(req, res);

        // M-C2：runId 的 mint 收敛到中间件（见 memory.middleware.test.ts C2），
        // 控制器只透传 req.meta 的值，缺值时不自行造值
        expect(
            vi.mocked(chatStreamService.streamChat).mock.calls[0]![0].runId,
        ).toBeUndefined();
        const paused = sseData(writes, 'run_paused') as { runId?: string };
        expect(paused.runId).toBeUndefined();
    });

    it('边界3：普通回复轮照常写 done，不写 run_paused', async () => {
        createMock.mockResolvedValue(
            streamOf([
                chunk({ content: '你好' }),
                chunk({ content: '' }, 'stop'),
            ]),
        );

        const { req, res, writes } = makeReqRes({
            messages: [{ role: 'user', content: '你好', msgId: 'm1' }],
        });

        await chat(req, res);

        expect(writes.filter((w) => w.includes('[DONE]')).length).toBe(1);
        expect(sseData(writes, 'run_paused')).toBeNull();
        expect(sseData(writes, 'tool_call')).toBeNull();
    });

    it('meta.mode 为 write 时把 write 透传到 Service', async () => {
        vi.mocked(chatStreamService.streamChat).mockResolvedValue(undefined);

        const { req, res } = makeReqRes(
            { messages: [{ role: 'user', content: '帮我写', msgId: 'm1' }] },
            { sessionId: 'sess-1', mode: 'write' },
        );

        await chat(req, res);

        expect(
            vi.mocked(chatStreamService.streamChat).mock.calls[0]![0].mode,
        ).toBe('write');
    });

    it('写模式把 meta.noteId 透传到 Service，chat 模式不带（避免 chat 消息误打标签）', async () => {
        vi.mocked(chatStreamService.streamChat).mockResolvedValue(undefined);

        const write = makeReqRes(
            { messages: [{ role: 'user', content: '帮我写', msgId: 'm1' }] },
            { sessionId: 'sess-1', mode: 'write', noteId: 'note-1' },
        );
        await chat(write.req, write.res);

        // 中间件对 chat 模式已强制 noteId 为 undefined，此处模拟其注入结果
        const chatMode = makeReqRes(
            { messages: [{ role: 'user', content: '你好', msgId: 'm1' }] },
            { sessionId: 'sess-1', mode: 'chat' },
        );
        await chat(chatMode.req, chatMode.res);

        const calls = vi.mocked(chatStreamService.streamChat).mock.calls;
        expect(calls[0]![0].noteId).toBe('note-1');
        expect(calls[1]![0].noteId).toBeUndefined();
    });
});

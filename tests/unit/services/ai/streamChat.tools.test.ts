/**
 * M-B1a：写模式透传 tools（单元测试）
 *
 * 验收标准：
 * - 写模式把 chatTools 透传给 SDK；chat 模式完全不发 Function Calling 参数
 * - thinking（extra_body.enable_thinking）未被透传改动挤掉
 * - 只断言"透传"，不重测 schema（属 M-A2 的 tools.test.ts），
 *   不测拼接 / 事件发射 / 落库（属 M-B1b / M-C1），不起真实网络、不真调 LLM
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

// ── Mock 外部依赖（hoisted，供 vi.mock 工厂引用）──
const { createMock, loggerMock } = vi.hoisted(() => ({
    createMock: vi.fn(),
    loggerMock: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => loggerMock,
}));

// 拦截 SDK 客户端：createStreamChat 的最终出参在这里被捕获
vi.mock('@/services/core/llm', () => ({
    getAIApi: () => ({ chat: { completions: { create: createMock } } }),
}));

// 既保留真实 createStreamChat（供 happy1 断言最终 params），
// 又让它成为 spy（供 happy2 断言 chatStream.service 传了什么 options）
vi.mock('@/services/ai.service', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('@/services/ai.service')>();
    return { ...actual, createStreamChat: vi.fn(actual.createStreamChat) };
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

import { createStreamChat } from '@/services/ai.service';
import chatStreamService from '@/services/chat/chatStream.service';
import { chatTools } from '@/services/chat/tools';
import STM from '@/utils/shortTermMemory';
import { sessionMemoryLifecycle } from '@/services/memory';
import memorySearchService from '@/services/memory/memorySearch.service';
import memorySelectionService from '@/services/memory/memorySelection.service';
import { injectNotesIntoSystemPrompt } from '@/services/notebook/noteInjection.service';

// ── 测试辅助 ──

/** 空的异步可迭代流：streamChat 的 for await 需要可迭代对象 */
function emptyStream() {
    return (async function* () {})();
}

/** 按顺序吐出给定 chunk 的流 */
function streamOf(chunks: ChatCompletionChunk[]) {
    return (async function* () {
        for (const chunk of chunks) yield chunk;
    })();
}

/** 只含工具调用增量的 chunk（真实字段远多于此处，故断言只看 delta.tool_calls） */
function toolCallChunk(toolCalls: unknown): ChatCompletionChunk {
    return {
        choices: [{ index: 0, delta: { tool_calls: toolCalls } }],
    } as unknown as ChatCompletionChunk;
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
        // M-B1b 起 runId 为必填 prop（本文件不关心其取值，仅满足形状）
        runId: 'run-1',
        onChunk: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue(emptyStream());
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
});

describe('createStreamChat — 透传 tools 到 SDK', () => {
    it('传入 tools 时透传给 SDK，且 thinking 与流式参数未被挤掉', async () => {
        await createStreamChat([{ role: 'user', content: '把标题改成 X' }], {
            tools: chatTools,
        });

        const params = createMock.mock.calls[0]?.[0];

        expect(params.tools).toHaveLength(3);
        expect(params.tools[0].function.name).toBe('update_title');
        expect(params.extra_body.enable_thinking).toBe(true);
        expect(params.stream).toBe(true);
        expect(params.stream_options.include_usage).toBe(true);
    });

    it('V1 单轮约束：传 tools 时一并下发 parallel_tool_calls: false', async () => {
        await createStreamChat([{ role: 'user', content: 'x' }], {
            tools: chatTools,
        });

        const params = createMock.mock.calls[0]?.[0];

        expect(params.parallel_tool_calls).toBe(false);
    });

    it('不传 tools（chat 模式）时完全不发 Function Calling 参数', async () => {
        await createStreamChat([{ role: 'user', content: '你好' }], {});

        const params = createMock.mock.calls[0]?.[0];

        expect(params.tools).toBeUndefined();
        expect('parallel_tool_calls' in params).toBe(false);
        expect(params.extra_body.enable_thinking).toBe(true);
    });

    it('tools 为空数组时同样不发（避免空工具列表改变请求形状）', async () => {
        await createStreamChat([{ role: 'user', content: '你好' }], {
            tools: [],
        });

        const params = createMock.mock.calls[0]?.[0];

        expect(params.tools).toBeUndefined();
        expect('parallel_tool_calls' in params).toBe(false);
    });
});

describe('chatStreamService — 按 mode 决定是否注入工具', () => {
    it('mode 为 write 时向 createStreamChat 透传 chatTools', async () => {
        await chatStreamService.streamChat(streamChatProps({ mode: 'write' }));

        const options = vi.mocked(createStreamChat).mock.calls[0]?.[1];

        expect(options?.tools).toBe(chatTools);
    });

    it('mode 为 chat 时 tools 为 undefined', async () => {
        await chatStreamService.streamChat(streamChatProps({ mode: 'chat' }));

        const options = vi.mocked(createStreamChat).mock.calls[0]?.[1];

        expect(options?.tools).toBeUndefined();
    });

    it('mode 缺省时按 chat 处理，tools 为 undefined', async () => {
        await chatStreamService.streamChat(streamChatProps());

        const options = vi.mocked(createStreamChat).mock.calls[0]?.[1];

        expect(options?.tools).toBeUndefined();
    });
});

describe('chatStreamService — 工具轮不落库（M-B1b 边界）', () => {
    // M-B1a 的 [tool_calls chunk] 观测打点已由 M-B1b 的拼接逻辑取代，
    // 对应断言随日志一并移除；拼接行为本身由 streamChat.toolcall.test.ts 覆盖。
    it('工具轮无 content：不写 STM、不落库', async () => {
        createMock.mockResolvedValue(
            streamOf([toolCallChunk([{ index: 0, id: 'call_1' }])]),
        );

        await chatStreamService.streamChat(
            streamChatProps({ mode: 'write', onToolCall: vi.fn() }),
        );

        expect(vi.mocked(STM.addMessages)).not.toHaveBeenCalled();
    });
});

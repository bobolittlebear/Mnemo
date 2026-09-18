/**
 * chat 控制器单元测试
 *
 * M-C2（上下文域值来源 = req.meta）：
 *   ① 写模式：streamChat 入参 mode/runId/noteId 全部取自 req.meta，不是 req.body
 *   ② meta 事件 data 回传 runId，客户端可据同一 run 续轮
 *   ③ chat 模式：meta 缺省 → mode 回落 chat，noteId/runId 均 undefined（Controller 不再自行 mint）
 *   ④ 会话不存在 → 404 且不进流式分支
 *
 * M-C3（续轮端点 + 首轮装配接线）：
 *   ⑤ 首轮写模式先 assembleWriteContext，再把本轮用户指令追加在历史之后
 *   ⑥ 装配失败（笔记超长闸门）→ 500，且 SSE 头都未写
 *   ⑦ handleToolResult：校验 → 落 tool 消息 → 重装上下文 → 内联续轮
 *   ⑧ 续轮校验：缺 toolCallId / status 非法 / 非写模式 / 缺 noteId → 400
 *
 * M-C4（轮数安全阀 + run 级终态）：
 *   ⑨ 已完成轮数 ≥3 且本轮回执 failed → 合成 run_finished 收尾，不再调第 4 次 LLM；
 *      成功轮（applied）不误杀，未触顶（1 轮）不误杀
 *   ⑩ 写模式 run 的自然收尾轮补 run_finished（位于 done 之前），chat 模式不发
 *   ⑪ 层2 兜底：本轮无可见正文时收尾前调 ensureRunVisibleMessage
 *
 * 全程 vi.mock 隔离重依赖（redis / Session / chatStream / writeModeContext / logger），
 * 不起真实服务、不发真实请求，断言聚焦「调用关系与入参」而非全链路。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖 ──

const {
    streamChatMock,
    assembleWriteContextMock,
    persistToolResultMock,
    countWriteRoundsMock,
    ensureRunVisibleMessageMock,
    loggerMock,
    sessionMock,
    redisMock,
    chatHistoryMock,
} = vi.hoisted(() => ({
    streamChatMock: vi.fn(),
    assembleWriteContextMock: vi.fn(),
    persistToolResultMock: vi.fn(),
    countWriteRoundsMock: vi.fn(),
    ensureRunVisibleMessageMock: vi.fn(),
    loggerMock: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    sessionMock: { findOne: vi.fn(), create: vi.fn(), updateOne: vi.fn() },
    redisMock: { set: vi.fn(), get: vi.fn() },
    chatHistoryMock: {
        endSession: vi.fn(),
        getHistory: vi.fn(),
        clearAll: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => loggerMock }));
vi.mock('@/lib/redis', () => ({ default: redisMock }));
vi.mock('@/models/Session', () => ({ default: sessionMock }));
vi.mock('@/services/chat/chatHistory.service', () => ({
    default: chatHistoryMock,
}));
// 流式对话服务整体隔离：本文件只验证 Controller 传了什么
vi.mock('@/services/chat/chatStream.service', () => ({
    default: { streamChat: streamChatMock },
}));
// 装配与 tool 回执落库隔离：只验证入参，不碰 MongoDB
vi.mock('@/services/chat/writeModeContext.service', () => ({
    assembleWriteContext: assembleWriteContextMock,
    persistToolResult: persistToolResultMock,
    countWriteRounds: countWriteRoundsMock,
    ensureRunVisibleMessage: ensureRunVisibleMessageMock,
}));

// ── 被测试模块 ──
import { chat, handleToolResult } from '@/controllers/chat.controller';

type ChatRequest = Parameters<typeof chat>[0];

/** 构造最小合规的 req/res mock；SSE 写入按顺序收集到 written */
function makeReqRes(overrides?: {
    meta?: ChatRequest['meta'];
    messages?: unknown[];
    body?: Record<string, unknown>;
}) {
    const req = {
        body: overrides?.body ?? {
            messages: overrides?.messages ?? [
                { role: 'user', content: '帮我写一段' },
            ],
        },
        user: { userId: 'u1' },
        meta: overrides?.meta ?? { sessionId: 's1' },
    } as unknown as ChatRequest;

    const written: string[] = [];
    const res = {
        locals: { traceId: 'trace-1' },
        setHeader: vi.fn(),
        write: vi.fn((chunk: string) => {
            written.push(chunk);
            return true;
        }),
        end: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };

    return { req, res: res as unknown as Parameters<typeof chat>[1], written };
}

/** 取第 n 个 SSE 事件的 data 载荷（事件形如 `event: x\ndata: {...}\n\n`） */
function sseData(chunk: string): Record<string, unknown> {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line!.slice('data: '.length)) as Record<string, unknown>;
}

/** 按事件名取首个匹配的 SSE 帧（断言事件顺序时用它，不写死下标） */
function sseEvent(chunks: string[], event: string): string | undefined {
    return chunks.find((c) => c.startsWith(`event: ${event}\n`));
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.findOne.mockResolvedValue({ status: 'active' });
    sessionMock.updateOne.mockResolvedValue({});
    sessionMock.create.mockResolvedValue({});
    redisMock.set.mockResolvedValue('OK');
    streamChatMock.mockResolvedValue(undefined);
    assembleWriteContextMock.mockResolvedValue({
        messages: [],
        systemPrompt: 'SYS',
    });
    persistToolResultMock.mockResolvedValue(undefined);
    countWriteRoundsMock.mockResolvedValue(0);
    ensureRunVisibleMessageMock.mockResolvedValue(false);
});

describe('chat — 上下文域取自 req.meta', () => {
    it('happy：写模式 → streamChat 入参 mode/runId/noteId 来自 meta，meta 事件回传 runId', async () => {
        const { req, res, written } = makeReqRes({
            meta: {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
        });

        await chat(req, res);

        expect(streamChatMock).toHaveBeenCalledTimes(1);
        const arg = streamChatMock.mock.calls[0]![0];
        expect(arg.sessionId).toBe('s1');
        expect(arg.userId).toBe('u1');
        expect(arg.traceId).toBe('trace-1');
        expect(arg.mode).toBe('write');
        expect(arg.runId).toBe('r1');
        expect(arg.noteId).toBe('n1');
        // 消息数组未被上下文域字段污染（设计 D3）
        expect(arg.messages[0].mode).toBeUndefined();
        expect(arg.messages[0].runId).toBeUndefined();

        // meta 事件：客户端拿 runId 才能在工具轮后按同一 run 续轮
        expect(written[0]).toContain('event: meta');
        expect(sseData(written[0]!)).toEqual({
            sessionId: 's1',
            title: '帮我写一段',
            runId: 'r1',
        });

        // 普通回复轮（未走工具）→ 补 done 并收尾
        expect(written[written.length - 1]).toBe(
            'event: done\ndata: [DONE]\n\n',
        );
        expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('边界1：chat 模式（meta 缺省）→ mode 回落 chat，noteId/runId 均 undefined 且不自行 mint', async () => {
        const { req, res, written } = makeReqRes({ meta: { sessionId: 's1' } });

        await chat(req, res);

        const arg = streamChatMock.mock.calls[0]![0];
        expect(arg.mode).toBe('chat');
        expect(arg.noteId).toBeUndefined();
        // 旧实现在 Controller 里 crypto.randomBytes 兜底 mint；M-C2 后 chat 模式不再有 runId
        expect(arg.runId).toBeUndefined();

        // runId 为 undefined 时 JSON.stringify 直接省略该键（不是空串）
        const metaData = sseData(written[0]!);
        expect('runId' in metaData).toBe(false);
        expect(metaData.sessionId).toBe('s1');
    });

    it('错误处理：会话不存在 → 404，不进流式分支', async () => {
        sessionMock.findOne.mockResolvedValue(null);
        const { req, res } = makeReqRes({
            meta: { sessionId: 's1', mode: 'write', noteId: 'n1', runId: 'r1' },
        });

        await chat(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: '会话不存在' });
        expect(streamChatMock).not.toHaveBeenCalled();
        expect(res.end).not.toHaveBeenCalled();
    });
});

describe('chat — 写模式首轮装配接线（M-C3）', () => {
    it('happy：先装配笔记上下文，再把本轮用户指令追加在历史之后', async () => {
        assembleWriteContextMock.mockResolvedValue({
            messages: [
                {
                    role: 'assistant',
                    content: '上一轮',
                    msgId: 'm0',
                    timestamp: 1,
                },
            ],
            systemPrompt: 'SYS-WRITE',
        });
        const { req, res } = makeReqRes({
            meta: {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
        });

        await chat(req, res);

        expect(assembleWriteContextMock).toHaveBeenCalledWith({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'r1',
            // M-C4：traceId 随装配下传，供层1 兜底合成消息溯源
            traceId: 'trace-1',
        });
        const arg = streamChatMock.mock.calls[0]![0];
        expect(arg.writeContext.systemPrompt).toBe('SYS-WRITE');
        // 本轮用户指令尚未落库（工具轮才落），必须由 Controller 追加在历史之后
        expect(
            arg.writeContext.messages.map(
                (m: { content: string }) => m.content,
            ),
        ).toEqual(['上一轮', '帮我写一段']);
        // chat 模式不装配，也不该拿到 writeContext
        expect(arg.messages).toHaveLength(1);
    });

    it('边界：装配失败（笔记超长闸门）→ 500，且 SSE 头与事件都未写', async () => {
        assembleWriteContextMock.mockRejectedValue(
            new Error('笔记内容过长（300000 字符），超出写作模式上限'),
        );
        const { req, res, written } = makeReqRes({
            meta: {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
        });

        await chat(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.setHeader).not.toHaveBeenCalled();
        expect(written).toEqual([]);
        expect(streamChatMock).not.toHaveBeenCalled();
        expect(loggerMock.error).toHaveBeenCalledWith(
            '流式对话失败',
            expect.objectContaining({ error: expect.any(Error) }),
        );
    });

    it('chat 模式：不调装配（无笔记上下文可言）', async () => {
        const { req, res } = makeReqRes({ meta: { sessionId: 's1' } });

        await chat(req, res);

        expect(assembleWriteContextMock).not.toHaveBeenCalled();
        expect(streamChatMock.mock.calls[0]![0].writeContext).toBeUndefined();
    });
});

describe('handleToolResult — 续轮端点', () => {
    /** 合规的续轮请求（写模式 + 全部必填字段） */
    function makeToolResultReq(overrides?: {
        body?: Record<string, unknown>;
        meta?: ChatRequest['meta'];
    }) {
        return makeReqRes({
            meta: overrides?.meta ?? {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
            body: overrides?.body ?? {
                toolCallId: 'tc1',
                status: 'applied',
                docHash: 'h',
                titleAfter: 't',
            },
        });
    }

    it('happy：落 tool 消息 → 重装上下文 → 内联续轮 SSE（meta 带 runId）', async () => {
        assembleWriteContextMock.mockResolvedValue({
            messages: [
                { role: 'tool', content: '{"status":"applied"}', msgId: 'm2' },
            ],
            systemPrompt: 'SYS',
        });
        const { req, res, written } = makeToolResultReq();

        await handleToolResult(req, res);

        expect(persistToolResultMock).toHaveBeenCalledTimes(1);
        expect(persistToolResultMock).toHaveBeenCalledWith({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'r1',
            traceId: 'trace-1',
            toolCallId: 'tc1',
            result: { status: 'applied', docHash: 'h', titleAfter: 't' },
        });
        expect(assembleWriteContextMock).toHaveBeenCalledWith({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'r1',
            // M-C4：traceId 随装配下传，供层1 兜底合成消息溯源
            traceId: 'trace-1',
        });
        // 续轮上下文必须包含刚落库的 tool 消息 → 落库必须先于装配
        expect(persistToolResultMock.mock.invocationCallOrder[0]).toBeLessThan(
            assembleWriteContextMock.mock.invocationCallOrder[0]!,
        );

        const arg = streamChatMock.mock.calls[0]![0];
        expect(arg.mode).toBe('write');
        expect(arg.runId).toBe('r1');
        expect(arg.noteId).toBe('n1');
        // 历史已在 writeContext 内，本轮无新用户消息
        expect(arg.messages).toEqual([]);
        expect(arg.writeContext.systemPrompt).toBe('SYS');
        expect(typeof arg.onToolCall).toBe('function');
        expect(typeof arg.onRunPaused).toBe('function');

        // FE 靠 meta 事件关联 run
        expect(sseData(written[0]!)).toEqual({ sessionId: 's1', runId: 'r1' });
        // 本轮未走工具（桩未回调）→ 补 done 收尾
        expect(written[written.length - 1]).toBe(
            'event: done\ndata: [DONE]\n\n',
        );
        expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('边界1：缺 toolCallId → 400，不落库不装配', async () => {
        const { req, res } = makeToolResultReq({
            body: { status: 'applied' },
        });

        await handleToolResult(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(persistToolResultMock).not.toHaveBeenCalled();
        expect(assembleWriteContextMock).not.toHaveBeenCalled();
    });

    it('边界2：status 非法（bogus）→ 400', async () => {
        const { req, res } = makeToolResultReq({
            body: { toolCallId: 'tc1', status: 'bogus' },
        });

        await handleToolResult(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'status 非法' });
        expect(persistToolResultMock).not.toHaveBeenCalled();
    });

    it('边界3：非写模式（chat）→ 400「仅写模式可用」', async () => {
        const { req, res } = makeToolResultReq({
            meta: { sessionId: 's1', mode: 'chat' },
        });

        await handleToolResult(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: '仅写模式可用' });
        expect(streamChatMock).not.toHaveBeenCalled();
    });

    it('边界4：写模式缺 noteId → 400，不落一条无笔记归属的 tool 消息', async () => {
        const { req, res } = makeToolResultReq({
            meta: { sessionId: 's1', mode: 'write', runId: 'r1' },
        });

        await handleToolResult(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: '写模式缺少 sessionId/noteId/runId',
        });
        expect(persistToolResultMock).not.toHaveBeenCalled();
    });

    it('错误处理：落库失败 → 500 JSON（SSE 头未写，客户端不接半截流）', async () => {
        persistToolResultMock.mockRejectedValue(new Error('mongo down'));
        const { req, res, written } = makeToolResultReq();

        await handleToolResult(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(written).toEqual([]);
        expect(streamChatMock).not.toHaveBeenCalled();
        expect(loggerMock.error).toHaveBeenCalledWith(
            '工具结果续轮失败',
            expect.objectContaining({ error: expect.any(Error) }),
        );
    });
});

describe('handleToolResult — 轮数安全阀（M-C4）', () => {
    /** 合规的续轮请求（写模式 + 全部必填字段） */
    function makeToolResultReq(overrides?: {
        body?: Record<string, unknown>;
        meta?: ChatRequest['meta'];
    }) {
        return makeReqRes({
            meta: overrides?.meta ?? {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
            body: overrides?.body ?? { toolCallId: 'tc1', status: 'failed' },
        });
    }

    it('happy：第 3 轮失败触顶 → 合成 run_finished 收尾，不再调第 4 次 LLM', async () => {
        countWriteRoundsMock.mockResolvedValue(3);
        const { req, res, written } = makeToolResultReq();

        await handleToolResult(req, res);

        // 判据：该 run 的已完成工具轮数（不是本轮之前）
        expect(countWriteRoundsMock).toHaveBeenCalledWith({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'r1',
        });
        // 失败回执仍要落库：run 的历史必须自洽
        expect(persistToolResultMock).toHaveBeenCalledTimes(1);

        // 收尾三件事：meta → run_finished（带合成说明）→ done，且不再进 LLM
        expect(streamChatMock).not.toHaveBeenCalled();
        expect(assembleWriteContextMock).not.toHaveBeenCalled();
        const finished = sseEvent(written, 'run_finished')!;
        expect(sseData(finished)).toEqual({
            runId: 'r1',
            reason: 'max_rounds_reached',
            message:
                '已在 3 轮内尝试但未能完成，run 已关闭。请检查笔记状态或手动调整。',
        });
        expect(written[written.length - 1]).toBe(
            'event: done\ndata: [DONE]\n\n',
        );
        // 层2 兜底：run 只有工具轮，用户侧必须看得见一条说明。
        // message 覆盖为阀门文案：落库的兜底消息与实时 run_finished.message 措辞一致
        expect(ensureRunVisibleMessageMock).toHaveBeenCalledWith({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'r1',
            traceId: 'trace-1',
            message:
                '已在 3 轮内尝试但未能完成，run 已关闭。请检查笔记状态或手动调整。',
        });
        expect(res.end).toHaveBeenCalledTimes(1);
        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写模式 run 触发轮数安全阀，已收尾',
            expect.objectContaining({
                runId: 'r1',
                rounds: 3,
                status: 'failed',
            }),
        );
    });

    it('边界1：轮数未触顶（1 轮）即使失败也继续跑 → 不触发阀门', async () => {
        countWriteRoundsMock.mockResolvedValue(1);
        const { req, res, written } = makeToolResultReq();

        await handleToolResult(req, res);

        expect(streamChatMock).toHaveBeenCalledTimes(1);
        expect(sseEvent(written, 'run_finished')).toBeDefined();
        expect(sseData(sseEvent(written, 'run_finished')!)).toEqual({
            runId: 'r1',
        });
    });

    it('边界2：第 3 轮成功（applied）不误杀 → 阀门只对失败触顶生效', async () => {
        countWriteRoundsMock.mockResolvedValue(3);
        const { req, res, written } = makeToolResultReq({
            body: { toolCallId: 'tc1', status: 'applied' },
        });

        await handleToolResult(req, res);

        // 模型仍在推进（本轮写入成功），继续给它第 4 轮
        expect(streamChatMock).toHaveBeenCalledTimes(1);
        const finished = sseEvent(written, 'run_finished')!;
        expect(sseData(finished)).toEqual({ runId: 'r1' });
        expect(loggerMock.warn).not.toHaveBeenCalledWith(
            '写模式 run 触发轮数安全阀，已收尾',
            expect.anything(),
        );
    });

    it('边界3：阀门收尾时落库失败 → 500 JSON，不吐半截 SSE', async () => {
        countWriteRoundsMock.mockResolvedValue(3);
        persistToolResultMock.mockRejectedValue(new Error('mongo down'));
        const { req, res, written } = makeToolResultReq();

        await handleToolResult(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(written).toEqual([]);
    });
});

describe('run 级终态 run_finished（M-C4）', () => {
    it('续轮自然收尾：无可见正文 → 补可见说明，再 run_finished → done', async () => {
        const { req, res, written } = makeReqRes({
            meta: {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
            body: { toolCallId: 'tc1', status: 'applied' },
        });

        await handleToolResult(req, res);

        // 桩未回调 onChunk → 本轮无可见正文，Service 侧同样跳过落库 → 触发层2 兜底
        expect(ensureRunVisibleMessageMock).toHaveBeenCalledWith({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'r1',
            traceId: 'trace-1',
        });
        expect(written.map((c) => c.split('\n')[0])).toEqual([
            'event: meta',
            'event: run_finished',
            'event: done',
        ]);
    });

    it('续轮自然收尾：本轮已产出正文 → 不再查可见性（避开落库的 setImmediate 窗口）', async () => {
        streamChatMock.mockImplementation(
            async (props: { onChunk: (c: string) => void }) => {
                props.onChunk('已按要求写入');
            },
        );
        const { req, res, written } = makeReqRes({
            meta: {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
            body: { toolCallId: 'tc1', status: 'applied' },
        });

        await handleToolResult(req, res);

        expect(ensureRunVisibleMessageMock).not.toHaveBeenCalled();
        expect(sseData(sseEvent(written, 'delta')!)).toEqual({
            content: '已按要求写入',
        });
        expect(written.map((c) => c.split('\n')[0])).toEqual([
            'event: meta',
            'event: delta',
            'event: run_finished',
            'event: done',
        ]);
    });

    it('首轮写模式即回复轮：补 run_finished，前端才有解锁信号', async () => {
        const { req, res, written } = makeReqRes({
            meta: {
                sessionId: 's1',
                mode: 'write',
                noteId: 'n1',
                runId: 'r1',
            },
        });

        await chat(req, res);

        expect(sseData(sseEvent(written, 'run_finished')!)).toEqual({
            runId: 'r1',
        });
        expect(written.map((c) => c.split('\n')[0])).toEqual([
            'event: meta',
            'event: run_finished',
            'event: done',
        ]);
    });

    it('首轮 chat 模式：无 run 可言，不出现 run_finished', async () => {
        const { req, res, written } = makeReqRes({ meta: { sessionId: 's1' } });

        await chat(req, res);

        expect(sseEvent(written, 'run_finished')).toBeUndefined();
        expect(written.map((c) => c.split('\n')[0])).toEqual([
            'event: meta',
            'event: done',
        ]);
    });
});

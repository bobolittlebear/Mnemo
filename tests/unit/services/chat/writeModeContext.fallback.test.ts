/**
 * M-C4：写模式双层兜底 + 轮数计数（单元测试）
 *
 * 验收标准：
 * - countWriteRounds：按 {sessionId, mode, noteId, runId, role:'assistant', toolCalls 存在} 计数，
 *   不查 userId（ChatMessage 无该字段）
 * - 层1（上下文完整性）：末位 assistant 带悬挂 toolCalls 时合成 cancelled tool 消息
 *   （原因落 result.error，不新增 schema 字段），并同步进本轮模型上下文
 * - 层1 不误伤：toolCallId 已被回答 / 末位无 toolCalls / 末位是 user → 一律不合成
 * - 层2（用户可感知性）：runId 下无可见 assistant 消息时补一条失败说明，已有则不动
 * - 全程 mock：不起真实 Mongo、不调 LLM、不读 Redis
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loggerMock, chatMessageMock, noteServiceMock } = vi.hoisted(() => ({
    loggerMock: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    chatMessageMock: {
        find: vi.fn(),
        create: vi.fn(),
        exists: vi.fn(),
        countDocuments: vi.fn(),
    },
    noteServiceMock: { getNoteById: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => loggerMock,
}));

vi.mock('@/models/ChatMessage', () => ({ default: chatMessageMock }));

vi.mock('@/services/notebook/note.service', () => ({
    default: noteServiceMock,
}));

import {
    assembleWriteContext,
    countWriteRounds,
    ensureRunVisibleMessage,
} from '@/services/chat/writeModeContext.service';
import type { RawMessage } from '@/types/chat';

// ── 测试辅助 ──

type LeanDoc = Record<string, unknown>;

/** 装配走 .find().sort().lean() 链，mock 整条链 */
function mockHistory(docs: LeanDoc[]) {
    const lean = vi.fn().mockResolvedValue(docs);
    const sort = vi.fn().mockReturnValue({ lean });
    chatMessageMock.find.mockReturnValue({ sort });
    return { sort, lean };
}

const toolMsgOf = (msg: RawMessage) =>
    msg as unknown as { role: string; content: string; tool_call_id: string };

const SCOPE = {
    sessionId: 's1',
    userId: 'u1',
    noteId: 'n1',
    runId: 'run-1',
    traceId: 'trace-1',
};

/** 末位悬挂的典型形状：assistant 已入库，tool 结果永不到达 */
const ORPHAN_HISTORY: LeanDoc[] = [
    { role: 'user', content: '把标题改成 X', msgId: 'm1', timestamp: 1000 },
    {
        role: 'assistant',
        content: '调用 update_title',
        msgId: 'm2',
        timestamp: 2000,
        toolCalls: [
            { id: 'c1', name: 'update_title', arguments: { new_title: 'X' } },
        ],
    },
];

beforeEach(() => {
    vi.clearAllMocks();
    noteServiceMock.getNoteById.mockResolvedValue({
        title: '会议纪要',
        content: '# 正文',
    });
    chatMessageMock.create.mockResolvedValue({});
    chatMessageMock.exists.mockResolvedValue(null);
    chatMessageMock.countDocuments.mockResolvedValue(0);
});

describe('countWriteRounds — 阀门判据', () => {
    it('happy：按 run 内「带 toolCalls 的 assistant 消息」计数，条件不含 userId', async () => {
        chatMessageMock.countDocuments.mockResolvedValue(3);

        const rounds = await countWriteRounds({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'run-1',
        });

        expect(rounds).toBe(3);
        expect(chatMessageMock.countDocuments).toHaveBeenCalledExactlyOnceWith({
            sessionId: 's1',
            mode: 'write',
            noteId: 'n1',
            runId: 'run-1',
            role: 'assistant',
            toolCalls: { $exists: true },
        });
    });

    it('边界1：无工具轮的新 run → 0', async () => {
        chatMessageMock.countDocuments.mockResolvedValue(0);

        expect(
            await countWriteRounds({
                sessionId: 's1',
                noteId: 'n1',
                runId: 'run-2',
            }),
        ).toBe(0);
    });

    it('错误处理：查询失败向上抛，不吞成 0（否则阀门永不触发）', async () => {
        chatMessageMock.countDocuments.mockRejectedValue(
            new Error('mongo down'),
        );

        await expect(
            countWriteRounds({ sessionId: 's1', noteId: 'n1', runId: 'run-1' }),
        ).rejects.toThrow('mongo down');
    });
});

describe('assembleWriteContext — 层1 悬挂 tool_call 兜底', () => {
    it('happy：末位悬挂 → 合成 cancelled tool 消息并进本轮上下文', async () => {
        mockHistory([...ORPHAN_HISTORY]);

        const ctx = await assembleWriteContext(SCOPE);

        // 落库形状：与 persistToolResult 同构，原因落 error（schema 无 reason）
        expect(chatMessageMock.create).toHaveBeenCalledTimes(1);
        const doc = chatMessageMock.create.mock.calls[0]![0];
        expect(doc.role).toBe('tool');
        expect(doc.content).toBe(
            '{"status":"cancelled","error":"client disconnected"}',
        );
        expect(doc.result).toEqual({
            status: 'cancelled',
            error: 'client disconnected',
        });
        expect(doc.toolCallId).toBe('c1');
        expect(doc.mode).toBe('write');
        expect(doc.noteId).toBe('n1');
        expect(doc.runId).toBe('run-1');
        expect(doc.sessionId).toBe('s1');
        expect(doc.traceId).toBe('trace-1');
        expect(doc.msgId).toMatch(/^msg-/);
        expect(typeof doc.timestamp).toBe('number');

        // 本轮喂模型的上下文必须已含这条工具结果，否则模型仍在等一个不会来的结果
        expect(ctx.messages).toHaveLength(3);
        const healed = toolMsgOf(ctx.messages[2]!);
        expect(healed.role).toBe('tool');
        expect(healed.tool_call_id).toBe('c1');
        expect(JSON.parse(healed.content)).toEqual({
            status: 'cancelled',
            error: 'client disconnected',
        });

        expect(loggerMock.info).toHaveBeenCalledWith(
            '孤儿 tool_call 已合成 cancelled 兜底',
            expect.objectContaining({
                sessionId: 's1',
                noteId: 'n1',
                runId: 'run-1',
                toolCallId: 'c1',
                duration_ms: expect.any(Number),
            }),
        );
    });

    it('边界1：toolCallId 已被回答 → 不合成，历史原样', async () => {
        mockHistory([
            ...ORPHAN_HISTORY,
            {
                role: 'tool',
                content: '{"status":"applied"}',
                msgId: 'm3',
                timestamp: 3000,
                toolCallId: 'c1',
            },
        ]);

        const ctx = await assembleWriteContext(SCOPE);

        expect(chatMessageMock.create).not.toHaveBeenCalled();
        expect(ctx.messages.map((m) => m.msgId)).toEqual(['m1', 'm2', 'm3']);
    });

    it('边界2：末位 assistant 无 toolCalls（回复轮）/ 末位是 user → 不合成', async () => {
        mockHistory([
            { role: 'user', content: '你好', msgId: 'm1', timestamp: 1000 },
            {
                role: 'assistant',
                content: '已写入第二段',
                msgId: 'm2',
                timestamp: 2000,
            },
            { role: 'user', content: '再写一段', msgId: 'm3', timestamp: 3000 },
        ]);

        await assembleWriteContext(SCOPE);

        expect(chatMessageMock.create).not.toHaveBeenCalled();
    });

    it('边界3：一个 assistant 并发两个 toolCalls，只补没回执的那个', async () => {
        mockHistory([
            {
                role: 'assistant',
                content: '调用两个工具',
                msgId: 'm1',
                timestamp: 1000,
                toolCalls: [
                    { id: 'c1', name: 'update_title', arguments: {} },
                    { id: 'c2', name: 'insert_at_cursor', arguments: {} },
                ],
            },
            {
                role: 'tool',
                content: '{"status":"applied"}',
                msgId: 'm2',
                timestamp: 2000,
                toolCallId: 'c1',
            },
        ]);

        const ctx = await assembleWriteContext(SCOPE);

        expect(chatMessageMock.create).toHaveBeenCalledTimes(1);
        expect(chatMessageMock.create.mock.calls[0]![0].toolCallId).toBe('c2');
        // 顺序仍是「assistant → 已回执的 tool → 合成的 tool」（合成消息 msgId 现生成）
        expect(ctx.messages.map((m) => m.msgId).slice(0, 2)).toEqual([
            'm1',
            'm2',
        ]);
        expect(ctx.messages.map((m) => m.msgId)[2]).toMatch(/^msg-/);
        expect(toolMsgOf(ctx.messages[2]!).tool_call_id).toBe('c2');
    });

    it('错误处理：合成写入失败 → 装配抛错，不假装补好了', async () => {
        mockHistory([...ORPHAN_HISTORY]);
        chatMessageMock.create.mockRejectedValue(new Error('mongo down'));

        await expect(assembleWriteContext(SCOPE)).rejects.toThrow('mongo down');
    });
});

describe('ensureRunVisibleMessage — 层2 用户可感知性兜底', () => {
    it('happy：runId 下无可见 assistant 消息 → 补一条可见失败说明', async () => {
        chatMessageMock.exists.mockResolvedValue(null);

        const inserted = await ensureRunVisibleMessage({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
        });

        expect(inserted).toBe(true);
        // 可见 = role assistant 且无 toolCalls（含 content 为空的故障消息）
        expect(chatMessageMock.exists).toHaveBeenCalledExactlyOnceWith({
            sessionId: 's1',
            mode: 'write',
            noteId: 'n1',
            runId: 'run-1',
            role: 'assistant',
            toolCalls: { $exists: false },
            isDeleted: false,
        });

        expect(chatMessageMock.create).toHaveBeenCalledTimes(1);
        const doc = chatMessageMock.create.mock.calls[0]![0];
        expect(doc.role).toBe('assistant');
        expect(doc.content).toBe('本次写作中断，未生成可见回复，请重试。');
        expect('toolCalls' in doc).toBe(false);
        expect(doc.mode).toBe('write');
        expect(doc.noteId).toBe('n1');
        expect(doc.runId).toBe('run-1');
        expect(doc.sessionId).toBe('s1');
        expect(doc.traceId).toBe('trace-1');
        expect(doc.msgId).toMatch(/^msg-/);
        expect(typeof doc.timestamp).toBe('number');

        expect(loggerMock.warn).toHaveBeenCalledWith(
            '写模式 run 无可见 assistant 消息，已补失败说明',
            expect.objectContaining({
                sessionId: 's1',
                noteId: 'n1',
                runId: 'run-1',
                duration_ms: expect.any(Number),
            }),
        );
    });

    it('边界1：已有可见 assistant 消息 → 不重复补（幂等）', async () => {
        chatMessageMock.exists.mockResolvedValue({ _id: 'x' });

        const inserted = await ensureRunVisibleMessage({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
        });

        expect(inserted).toBe(false);
        expect(chatMessageMock.create).not.toHaveBeenCalled();
    });

    it('边界2：传 message 覆盖 → 落库文案用覆盖值（阀门路径与 run_finished 措辞一致）', async () => {
        chatMessageMock.exists.mockResolvedValue(null);

        const inserted = await ensureRunVisibleMessage({
            sessionId: 's1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            message: '已在 3 轮内尝试但未能完成，run 已关闭。',
        });

        expect(inserted).toBe(true);
        expect(chatMessageMock.create.mock.calls[0]![0].content).toBe(
            '已在 3 轮内尝试但未能完成，run 已关闭。',
        );
    });

    it('错误处理：查询失败向上抛，不静默补错消息', async () => {
        chatMessageMock.exists.mockRejectedValue(new Error('mongo down'));

        await expect(
            ensureRunVisibleMessage({
                sessionId: 's1',
                noteId: 'n1',
                runId: 'run-1',
                traceId: 'trace-1',
            }),
        ).rejects.toThrow('mongo down');
        expect(chatMessageMock.create).not.toHaveBeenCalled();
    });
});

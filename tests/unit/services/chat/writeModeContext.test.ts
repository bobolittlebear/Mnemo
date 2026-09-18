/**
 * M-C1：写模式上下文装配 + tool 消息持久化（单元测试）
 *
 * 验收标准：
 * - 装配只读 MongoDB（三条件 {sessionId, mode:'write', noteId}），不碰 STM
 * - 重建 tool_calls 时 arguments 必须是 JSON 字符串（存储是对象，协议要字符串）
 * - tool 消息 content 落库即 JSON.stringify(result)，装配时原样透传
 * - tool 轮 assistant 无正文时 content 兜底非空（schema content required）
 * - 笔记每轮重取：多轮 patch 后第 N 轮必须看到最新全文
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
    chatMessageMock: { find: vi.fn(), insertMany: vi.fn(), create: vi.fn() },
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
    persistWriteRound,
    persistToolResult,
} from '@/services/chat/writeModeContext.service';
import type { RawMessage } from '@/types/chat';

// ── 测试辅助 ──

type LeanDoc = Record<string, unknown>;

/** 装配走 .find().sort().lean() 链，mock 整条链并返回 sort spy 供断言 */
function mockHistory(docs: LeanDoc[]) {
    const lean = vi.fn().mockResolvedValue(docs);
    const sort = vi.fn().mockReturnValue({ lean });
    chatMessageMock.find.mockReturnValue({ sort });
    return { sort, lean };
}

function makeUserMsg(content = '把标题改成 X'): RawMessage {
    return {
        role: 'user',
        content,
        msgId: 'msg-u1',
        timestamp: 1000,
    } as RawMessage;
}

/** 协议形状的 tool_call（arguments 是 JSON 字符串） */
type ProtocolToolCall = {
    id: string;
    type: string;
    function: { name: string; arguments: unknown };
};

const assistantOf = (msg: RawMessage) =>
    msg as unknown as {
        role: string;
        content: string;
        tool_calls?: ProtocolToolCall[];
    };

const toolMsgOf = (msg: RawMessage) =>
    msg as unknown as { role: string; content: string; tool_call_id: string };

const ASSEMBLE_PROPS = {
    sessionId: 's1',
    userId: 'u1',
    noteId: 'n1',
    runId: 'run-1',
};

beforeEach(() => {
    vi.clearAllMocks();
    noteServiceMock.getNoteById.mockResolvedValue({
        title: '会议纪要',
        content: '# 正文',
    });
    chatMessageMock.insertMany.mockResolvedValue([]);
    chatMessageMock.create.mockResolvedValue({});
});

describe('assembleWriteContext', () => {
    it('happy1：装配历史并重建 tool_calls（arguments 转成 JSON 字符串）', async () => {
        const storedResult = { status: 'applied', docHash: 'hash-1' };
        const { sort } = mockHistory([
            {
                role: 'user',
                content: '把标题改成 X',
                msgId: 'm1',
                timestamp: 1000,
            },
            {
                role: 'assistant',
                content: '调用 update_title',
                msgId: 'm2',
                timestamp: 2000,
                toolCalls: [
                    {
                        id: 'call_1',
                        name: 'update_title',
                        arguments: { new_title: 'X' },
                    },
                ],
            },
            {
                role: 'tool',
                content: JSON.stringify(storedResult),
                msgId: 'm3',
                timestamp: 3000,
                toolCallId: 'call_1',
            },
        ]);

        const ctx = await assembleWriteContext(ASSEMBLE_PROPS);

        // 三条件收敛 + 按笔记隔离 + 软删除不回流
        expect(chatMessageMock.find).toHaveBeenCalledExactlyOnceWith({
            sessionId: 's1',
            mode: 'write',
            noteId: 'n1',
            isDeleted: false,
        });
        expect(sort).toHaveBeenCalledWith({ timestamp: 1 });
        expect(noteServiceMock.getNoteById).toHaveBeenCalledExactlyOnceWith(
            'n1',
            'u1',
        );

        // 顺序与 timestamp 一致（旧 → 新）
        expect(ctx.messages.map((m) => m.msgId)).toEqual(['m1', 'm2', 'm3']);
        expect(ctx.messages.map((m) => m.role)).toEqual([
            'user',
            'assistant',
            'tool',
        ]);

        // assistant 工具轮：tool_calls 重建，arguments 必须是字符串而非对象
        const assistant = assistantOf(ctx.messages[1]!);
        expect(assistant.content).toBe('调用 update_title');
        expect(assistant.tool_calls).toHaveLength(1);
        expect(assistant.tool_calls![0]!.id).toBe('call_1');
        expect(assistant.tool_calls![0]!.type).toBe('function');
        expect(assistant.tool_calls![0]!.function.name).toBe('update_title');
        expect(typeof assistant.tool_calls![0]!.function.arguments).toBe(
            'string',
        );
        expect(assistant.tool_calls![0]!.function.arguments).toBe(
            '{"new_title":"X"}',
        );

        // tool 结果轮：content 透传（已是 JSON 串），tool_call_id 指向 assistant 的工具调用
        const toolMsg = toolMsgOf(ctx.messages[2]!);
        expect(toolMsg.content).toBe(JSON.stringify(storedResult));
        expect(toolMsg.tool_call_id).toBe('call_1');

        // 笔记全文快照进 system prompt，且 messages 里不含 system
        expect(ctx.systemPrompt).toContain('<write_mode_instructions>');
        expect(ctx.systemPrompt).toContain('<title>会议纪要</title>');
        expect(ctx.systemPrompt).toContain('# 正文');
        expect(ctx.messages.some((m) => m.role === 'system')).toBe(false);
    });

    it('边界1：每次装配都重取笔记，patch 后的最新全文立即生效', async () => {
        mockHistory([]);

        noteServiceMock.getNoteById.mockResolvedValueOnce({
            title: '会议纪要',
            content: '# 第一版',
        });
        const first = await assembleWriteContext(ASSEMBLE_PROPS);

        noteServiceMock.getNoteById.mockResolvedValueOnce({
            title: '会议纪要',
            content: '# 第一版\n\n## 新增章节',
        });
        const second = await assembleWriteContext(ASSEMBLE_PROPS);

        expect(noteServiceMock.getNoteById).toHaveBeenCalledTimes(2);
        expect(first.systemPrompt).toContain('# 第一版');
        expect(first.systemPrompt).not.toContain('## 新增章节');
        expect(second.systemPrompt).toContain('## 新增章节');
    });

    it('边界2：笔记不存在时装配抛错，且不读历史', async () => {
        noteServiceMock.getNoteById.mockRejectedValue(new Error('笔记不存在'));

        await expect(assembleWriteContext(ASSEMBLE_PROPS)).rejects.toThrow(
            '笔记不存在',
        );
        expect(chatMessageMock.find).not.toHaveBeenCalled();
    });

    it('边界3：无 toolCalls 的 assistant 消息不带 tool_calls 字段', async () => {
        mockHistory([
            { role: 'user', content: '你好', msgId: 'm1', timestamp: 1000 },
            {
                role: 'assistant',
                content: '已写入第二段',
                msgId: 'm2',
                timestamp: 2000,
            },
        ]);

        const ctx = await assembleWriteContext(ASSEMBLE_PROPS);

        expect(ctx.messages).toHaveLength(2);
        expect('tool_calls' in ctx.messages[1]!).toBe(false);
        expect('tool_call_id' in ctx.messages[1]!).toBe(false);
        expect(assistantOf(ctx.messages[1]!).content).toBe('已写入第二段');
    });

    it('边界4：笔记超防御闸门时抛错，不装配历史', async () => {
        noteServiceMock.getNoteById.mockResolvedValue({
            title: '超长笔记',
            content: 'x'.repeat(200_001),
        });

        await expect(assembleWriteContext(ASSEMBLE_PROPS)).rejects.toThrow(
            /超出写作模式上限/,
        );
        expect(chatMessageMock.find).not.toHaveBeenCalled();
    });
});

describe('persistWriteRound', () => {
    it('happy2：落 user + assistant 两条，空 content 兜底成工具摘要', async () => {
        await persistWriteRound({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            userMsg: makeUserMsg(),
            assistantMsg: { content: '', msgId: 'msg-a1' },
            toolCalls: [
                {
                    id: 'call_1',
                    name: 'update_title',
                    arguments: { new_title: 'X' },
                },
            ],
        });

        expect(chatMessageMock.insertMany).toHaveBeenCalledTimes(1);
        const [docs, options] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(options).toEqual({ ordered: true });
        expect(docs).toHaveLength(2);

        expect(docs[0]).toEqual({
            role: 'user',
            content: '把标题改成 X',
            timestamp: 1000,
            msgId: 'msg-u1',
            traceId: 'trace-1',
            sessionId: 's1',
            mode: 'write',
            noteId: 'n1',
            runId: 'run-1',
        });

        const assistant = docs[1]!;
        expect(assistant.role).toBe('assistant');
        expect(assistant.content).toBe('调用 update_title');
        expect(assistant.msgId).toBe('msg-a1');
        expect(assistant.traceId).toBe('trace-1');
        expect(assistant.mode).toBe('write');
        expect(assistant.noteId).toBe('n1');
        expect(assistant.runId).toBe('run-1');
        expect(assistant.toolCalls).toEqual([
            {
                id: 'call_1',
                name: 'update_title',
                arguments: { new_title: 'X' },
            },
        ]);
    });

    it('边界1：assistant 有正文时用原文，不覆盖成摘要', async () => {
        await persistWriteRound({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            userMsg: makeUserMsg(),
            assistantMsg: { content: '标题已改好', msgId: 'msg-a1' },
        });

        const [docs] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(docs[1]!.content).toBe('标题已改好');
        // 无 toolCalls 时不写 toolCalls 字段（schema 关掉了数组默认值）
        expect('toolCalls' in docs[1]!).toBe(false);
    });

    it('边界2：纯空白 content 与无工具时各自兜底成非空摘要', async () => {
        await persistWriteRound({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            assistantMsg: { content: '   ', msgId: 'msg-a1' },
            toolCalls: [
                { id: 'call_1', name: 'insert_at_cursor', arguments: '{}' },
            ],
        });
        await persistWriteRound({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            assistantMsg: { content: undefined, msgId: 'msg-a2' },
        });

        const first = chatMessageMock.insertMany.mock.calls[0]![0];
        const second = chatMessageMock.insertMany.mock.calls[1]![0];
        // 空白 content 被 trim 成空 → 走工具摘要
        expect(first[0]!.content).toBe('调用 insert_at_cursor');
        expect(second[0]!.content).toBe('(工具调用)');
        // argsBuf 解析失败的原串原样落库，装配时原样回喂
        expect(first[0]!.toolCalls).toEqual([
            { id: 'call_1', name: 'insert_at_cursor', arguments: '{}' },
        ]);
    });

    it('边界3：续轮不重复落用户消息（userMsg 缺省时只落 assistant）', async () => {
        await persistWriteRound({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            assistantMsg: { content: '调用 insert_at_cursor', msgId: 'msg-a1' },
        });

        const [docs] = chatMessageMock.insertMany.mock.calls[0]!;
        expect(docs).toHaveLength(1);
        expect(docs[0]!.role).toBe('assistant');
        expect(docs[0]!.mode).toBe('write');
        expect(docs[0]!.runId).toBe('run-1');
    });
});

describe('persistToolResult', () => {
    it('happy3：tool 消息 content 为 JSON 串，result 原样结构化落库', async () => {
        const result = {
            status: 'failed' as const,
            error: '锚点失配',
            docHash: 'hash-2',
        };

        await persistToolResult({
            sessionId: 's1',
            userId: 'u1',
            noteId: 'n1',
            runId: 'run-1',
            traceId: 'trace-1',
            toolCallId: 'call_1',
            result,
        });

        expect(chatMessageMock.create).toHaveBeenCalledTimes(1);
        const doc = chatMessageMock.create.mock.calls[0]![0];
        expect(doc.role).toBe('tool');
        expect(doc.content).toBe(
            '{"status":"failed","error":"锚点失配","docHash":"hash-2"}',
        );
        expect(doc.toolCallId).toBe('call_1');
        expect(doc.result).toEqual(result);
        expect(doc.mode).toBe('write');
        expect(doc.noteId).toBe('n1');
        expect(doc.runId).toBe('run-1');
        expect(doc.sessionId).toBe('s1');
        expect(doc.traceId).toBe('trace-1');
        expect(doc.msgId).toMatch(/^msg-/);
        expect(typeof doc.timestamp).toBe('number');
    });
});

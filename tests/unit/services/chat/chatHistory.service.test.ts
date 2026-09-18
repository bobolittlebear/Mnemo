/**
 * chatHistory.service 单元测试
 *
 * 测试目标：
 *   C1: endSession → Session.updateOne 参数为 { sessionId }, { $set: { status: 'archived' } }
 *   C2: clearAll → ChatMessage.updateMany 软删除 + Session.updateOne status → 'deleted'
 *   C3: clearAll 时 Session.updateOne reject → 不抛异常，ChatMessage.updateMany 正常执行
 *
 * M-D1（getHistory 投影补齐写模式新字段）：
 *   D1: 写模式消息的 mode/noteId/runId/toolCalls/toolCallId/result 六个字段随历史返回
 *   D2: chat 消息（无这些字段）映射出来是 undefined，不误造字段
 *   D3: toolCalls.arguments 透传存储原值——结构化对象与回退原串都不二次 parse
 *   D4: result 整对象透传（failed 带 error）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖 ──

const {
    mockChatMessageUpdateMany,
    mockChatMessageFind,
    mockSessionUpdateOne,
    mockSessionEndTriggerEnd,
    mockSessionMemoryLifecycleDestroy,
} = vi.hoisted(() => ({
    mockChatMessageUpdateMany: vi.fn(),
    mockChatMessageFind: vi.fn(),
    mockSessionUpdateOne: vi.fn(),
    mockSessionEndTriggerEnd: vi.fn(),
    mockSessionMemoryLifecycleDestroy: vi.fn(),
}));

vi.mock('@/lib/logger', () => {
    const shared = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    return { createLogger: vi.fn(() => shared) };
});

vi.mock('@/models/ChatMessage', () => ({
    default: {
        updateMany: mockChatMessageUpdateMany,
        find: mockChatMessageFind,
    },
}));

vi.mock('@/models/Session', () => ({
    default: {
        updateOne: mockSessionUpdateOne,
    },
}));

vi.mock('@/services/memory', () => ({
    sessionEndTrigger: {
        end: mockSessionEndTriggerEnd,
    },
    sessionMemoryLifecycle: {
        destroy: mockSessionMemoryLifecycleDestroy,
    },
}));

// ── 被测试模块 ──
import chatHistoryService from '@/services/chat/chatHistory.service';
import type { HistoryMessage } from '@/types/chat';

/**
 * 自审（编译期）：六个新字段已可选地存在于 HistoryMessage。
 * 这段字面量能通过类型检查，即证明类型定义已扩；类型写错会让本文件编译失败。
 */
const historyMessageShape: HistoryMessage = {
    id: '650000000000000000000001',
    role: 'assistant',
    content: '调用 insert_at_cursor',
    timestamp: '2024-03-09T16:00:00.000Z',
    msgId: 'm1',
    mode: 'write',
    noteId: 'n1',
    runId: 'r1',
    toolCalls: [
        { id: 'c1', name: 'insert_at_cursor', arguments: { markdown: 'x' } },
    ],
    toolCallId: 'c1',
    result: { status: 'applied', docHash: 'h', titleAfter: 'T' },
};

/** getHistory 走 .find().sort().limit().lean() 链，mock 整条链并返回各环节 spy 供断言 */
function mockHistory(docs: Record<string, unknown>[]) {
    const lean = vi.fn().mockResolvedValue(docs);
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    mockChatMessageFind.mockReturnValue({ sort });
    return { sort, limit, lean };
}

/** lean 结果的 _id 只需支持 toString（getHistory 仅用它拼 id） */
const oid = (value: string) => ({ toString: () => value });

beforeEach(() => {
    mockChatMessageUpdateMany.mockReset();
    mockChatMessageFind.mockReset();
    mockSessionUpdateOne.mockReset();
    mockSessionEndTriggerEnd.mockReset();
    mockSessionMemoryLifecycleDestroy.mockReset();

    // 默认 resolve
    mockChatMessageUpdateMany.mockResolvedValue({ modifiedCount: 5 });
    mockSessionUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockSessionEndTriggerEnd.mockResolvedValue(undefined);
    mockSessionMemoryLifecycleDestroy.mockResolvedValue(undefined);
    mockHistory([]);
});

// ── 测试用例 ──

describe('chatHistoryService', () => {
    describe('endSession', () => {
        it('C1: 调用 Session.updateOne 参数为 { sessionId }, { $set: { status: "archived" } }', async () => {
            await chatHistoryService.endSession({
                sessionId: 'sid',
                userId: 'u1',
            });

            // 验证触发终态提取
            expect(mockSessionEndTriggerEnd).toHaveBeenCalledTimes(1);
            expect(mockSessionEndTriggerEnd).toHaveBeenCalledWith('sid');

            // Session.updateOne 是 fire-and-forget（.catch），用 waitFor 风格等待微任务
            // 等待一个 tick 让 Promise 回调执行
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockSessionUpdateOne).toHaveBeenCalledTimes(1);
            expect(mockSessionUpdateOne).toHaveBeenCalledWith(
                { sessionId: 'sid' },
                { $set: { status: 'archived' } },
            );
        });
    });

    describe('clearAll', () => {
        it('C2: ChatMessage.updateMany 软删除 + Session.updateOne status → deleted', async () => {
            mockChatMessageUpdateMany.mockResolvedValue({ modifiedCount: 3 });

            const result = await chatHistoryService.clearAll({
                sessionId: 'sid',
                userId: 'u1',
            });

            // 验证终态提取触发
            expect(mockSessionEndTriggerEnd).toHaveBeenCalledTimes(1);
            expect(mockSessionEndTriggerEnd).toHaveBeenCalledWith('sid');

            // 验证软删除
            expect(mockChatMessageUpdateMany).toHaveBeenCalledTimes(1);
            expect(mockChatMessageUpdateMany).toHaveBeenCalledWith(
                { sessionId: 'sid', isDeleted: { $ne: true } },
                { $set: { isDeleted: true } },
            );

            // 验证销毁触发器状态
            expect(mockSessionMemoryLifecycleDestroy).toHaveBeenCalledTimes(1);
            expect(mockSessionMemoryLifecycleDestroy).toHaveBeenCalledWith(
                'sid',
            );

            // 等待 fire-and-forget
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockSessionUpdateOne).toHaveBeenCalledTimes(1);
            expect(mockSessionUpdateOne).toHaveBeenCalledWith(
                { sessionId: 'sid' },
                { $set: { status: 'deleted' } },
            );

            expect(result).toEqual({ deletedCount: 3 });
        });

        it('C3: Session.updateOne reject → 不抛异常，ChatMessage.updateMany 正常执行', async () => {
            mockSessionUpdateOne.mockRejectedValue(
                new Error('Session 更新失败'),
            );
            mockChatMessageUpdateMany.mockResolvedValue({ modifiedCount: 7 });

            // 不应抛异常
            const result = await chatHistoryService.clearAll({
                sessionId: 'sid',
                userId: 'u1',
            });

            // ChatMessage.updateMany 正常执行
            expect(mockChatMessageUpdateMany).toHaveBeenCalledTimes(1);

            // 返回正确的 deletedCount
            expect(result).toEqual({ deletedCount: 7 });
        });
    });

    describe('getHistory — 写模式新字段投影（M-D1）', () => {
        it('D1: 写模式消息的六个新字段随历史返回，既有字段映射不变', async () => {
            const { sort, limit } = mockHistory([
                {
                    _id: oid('oid-1'),
                    role: 'assistant',
                    content: '调用 insert_at_cursor',
                    timestamp: 1710000000000,
                    msgId: 'm1',
                    traceId: 't',
                    mode: 'write',
                    noteId: 'n1',
                    runId: 'r1',
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'insert_at_cursor',
                            arguments: { markdown: 'x' },
                        },
                    ],
                    toolCallId: 'c1',
                    result: {
                        status: 'applied',
                        docHash: 'h',
                        titleAfter: 'T',
                    },
                },
            ]);

            const [msg] = await chatHistoryService.getHistory('sid', 20);

            // 查询条件与分页未变（本次只扩映射）
            expect(mockChatMessageFind).toHaveBeenCalledWith({
                sessionId: 'sid',
                isDeleted: false,
            });
            expect(sort).toHaveBeenCalledWith({ _id: -1 });
            expect(limit).toHaveBeenCalledWith(20);

            // 既有字段
            expect(msg!.id).toBe('oid-1');
            expect(msg!.role).toBe('assistant');
            expect(msg!.content).toBe('调用 insert_at_cursor');
            expect(msg!.timestamp).toBe(new Date(1710000000000).toISOString());
            expect(msg!.msgId).toBe('m1');
            expect(msg!.traceId).toBe('t');

            // 写模式新字段：前端据 runId 聚合成「run 气泡」、渲染工具调用与结果
            expect(msg!.mode).toBe('write');
            expect(msg!.noteId).toBe('n1');
            expect(msg!.runId).toBe('r1');
            expect(msg!.toolCallId).toBe('c1');
            expect(msg!.toolCalls).toHaveLength(1);
            expect(msg!.toolCalls![0]!.id).toBe('c1');
            expect(msg!.toolCalls![0]!.name).toBe('insert_at_cursor');
            expect(msg!.toolCalls![0]!.arguments).toEqual({ markdown: 'x' });
            expect(msg!.result!.status).toBe('applied');
            expect(msg!.result!.docHash).toBe('h');
            expect(msg!.result!.titleAfter).toBe('T');
        });

        it('D2: chat 消息无这些字段 → 全部 undefined，不误造字段', async () => {
            mockHistory([
                {
                    _id: oid('oid-2'),
                    role: 'user',
                    content: '你好',
                    timestamp: 1710000000000,
                    msgId: 'm2',
                    traceId: 't',
                },
            ]);

            const [msg] = await chatHistoryService.getHistory('sid', 20);

            expect(msg!.mode).toBeUndefined();
            expect(msg!.noteId).toBeUndefined();
            expect(msg!.runId).toBeUndefined();
            expect(msg!.toolCalls).toBeUndefined();
            expect(msg!.toolCallId).toBeUndefined();
            expect(msg!.result).toBeUndefined();
            expect(msg!.content).toBe('你好');
        });

        it('D3: toolCalls.arguments 透传存储原值，回退原串不二次 parse', async () => {
            mockHistory([
                {
                    _id: oid('oid-3'),
                    role: 'assistant',
                    content: '调用 insert_at_cursor',
                    timestamp: 1710000000000,
                    msgId: 'm3',
                    traceId: 't',
                    mode: 'write',
                    noteId: 'n1',
                    runId: 'r1',
                    toolCalls: [
                        {
                            id: 'c2',
                            name: 'insert_at_cursor',
                            // safeParseToolArgs 解析失败时落库的就是这个原串
                            arguments: '{"markdown":"x"',
                        },
                    ],
                },
            ]);

            const [msg] = await chatHistoryService.getHistory('sid', 20);

            // 仍是字符串：前端执行器自己决定怎么处理，读出侧不得擅自 parse/兜底成 {}
            expect(typeof msg!.toolCalls![0]!.arguments).toBe('string');
            expect(msg!.toolCalls![0]!.arguments).toBe('{"markdown":"x"');
        });

        it('D4: result 整对象透传（failed 带 error，供前端展示失败原因）', async () => {
            mockHistory([
                {
                    _id: oid('oid-4'),
                    role: 'tool',
                    content: '{"status":"failed","error":"doc drifted"}',
                    timestamp: 1710000000000,
                    msgId: 'm4',
                    traceId: 't',
                    mode: 'write',
                    noteId: 'n1',
                    runId: 'r1',
                    toolCallId: 'c3',
                    result: { status: 'failed', error: 'doc drifted' },
                },
            ]);

            const [msg] = await chatHistoryService.getHistory('sid', 20);

            expect(msg!.role).toBe('tool');
            expect(msg!.toolCallId).toBe('c3');
            expect(msg!.result).toEqual({
                status: 'failed',
                error: 'doc drifted',
            });
            // docHash/titleAfter 未回传时不凭空补齐
            expect('docHash' in msg!.result!).toBe(false);
        });

        it('D5（自审）: 分页游标不变，且倒序取回后仍按旧→新返回', async () => {
            const { sort } = mockHistory([
                {
                    _id: oid('oid-new'),
                    role: 'assistant',
                    content: '新',
                    timestamp: 2000,
                    msgId: 'm-new',
                    traceId: 't',
                },
                {
                    _id: oid('oid-old'),
                    role: 'user',
                    content: '旧',
                    timestamp: 1000,
                    msgId: 'm-old',
                    traceId: 't',
                },
            ]);

            const list = await chatHistoryService.getHistory(
                'sid',
                20,
                '650000000000000000000002',
            );

            expect(sort).toHaveBeenCalledWith({ _id: -1 });
            // 入参是倒序（_id: -1）取最新的 limit 条，返回前 reverse 成正序
            expect(list.map((m) => m.msgId)).toEqual(['m-old', 'm-new']);
        });
    });

    it('类型自审：HistoryMessage 已含六个可选新字段', () => {
        expect(historyMessageShape.mode).toBe('write');
        expect(historyMessageShape.toolCalls![0]!.arguments).toEqual({
            markdown: 'x',
        });
        expect(historyMessageShape.result!.status).toBe('applied');
        // 六个字段外仍可省略（老消费方的写法继续编译通过）
        const legacy: HistoryMessage = {
            id: '1',
            role: 'user',
            content: 'hi',
            timestamp: '2024-03-09T16:00:00.000Z',
            msgId: 'm0',
        };
        expect(legacy.mode).toBeUndefined();
    });
});

/**
 * ChatMessage 模型单元测试（工具调用链路 schema 扩容）
 *
 * 对应设计：.claude/design/tool-calling/tool-calling-detail.md §6.3
 *
 * 验收标准：
 * - role enum 纳入 'tool'，tool 结果消息不再被 Mongoose 拒收
 * - 既有的 user / assistant / system 三个 role 行为不破
 * - 新增字段 mode / noteId / toolCalls / toolCallId / result / runId 均为可选
 * - toolCalls.arguments 为 Mixed，容忍 LLM 动态参数结构
 * - result.status 受 enum 约束（applied / failed / cancelled）
 * - 不新增索引、不引入 display 字段、既有落库形状不变
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import ChatMessage from '@/models/ChatMessage';
import type { ChatMessage as RawChatMessage } from '@/types/models';

/**
 * 测试用的宽松文档形状：在类型层把枚举字段放宽为 string，
 * 以便构造"非法值应被拒绝"的用例（运行时仍受 schema enum 约束）。
 * 用 Omit 覆盖而非交叉——交叉会取窄，反而写不进 'foo'。
 */
type ExpandedChatMessage = Omit<
    RawChatMessage,
    'mode' | 'result' | 'toolCalls'
> & {
    mode?: string;
    noteId?: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>;
    toolCallId?: string;
    result?: {
        status?: string;
        docHash?: string;
        titleAfter?: string;
        error?: string;
    };
    runId?: string;
};

/** 既有落库形状的最小合法文档（对齐 chatStream.service.ts 的 persistConversation） */
function buildMessage(overrides: Partial<ExpandedChatMessage> = {}) {
    return new ChatMessage({
        sessionId: 'sess-1',
        msgId: 'msg-1',
        traceId: 'trace-1',
        timestamp: 1700000000000,
        role: 'user',
        content: '你好',
        ...overrides,
    }) as ExpandedChatMessage;
}

describe('ChatMessage 模型 — role enum 纳入 tool', () => {
    it('role: tool 的工具结果消息可通过校验', () => {
        const doc = buildMessage({
            role: 'tool',
            content: '已更新标题',
            toolCallId: 'call_x',
            result: { status: 'applied', docHash: 'h' },
        });

        expect(doc.validateSync()).toBeUndefined();
    });

    it.each(['user', 'assistant', 'system'])(
        '既有 role: %s 消息仍通过校验（既有行为不破）',
        (role) => {
            expect(buildMessage({ role }).validateSync()).toBeUndefined();
        },
    );

    it('role: unknown 仍被 enum 拒绝（enum 未退化成任意字符串）', () => {
        const err = buildMessage({ role: 'unknown' }).validateSync();

        expect(err?.errors.role).toBeInstanceOf(mongoose.Error.ValidatorError);
        expect(err?.errors.role?.message).toContain(
            'is not a valid enum value for path `role`',
        );
    });

    it('【已知约束】role: tool 的 content 为空串仍被 required 拒绝', () => {
        // content 保持 required: true（Mongoose 视空串为缺失）。
        // 设计 §6.3 允许 tool 消息 content 为空串，该场景须由 M-C1 自行处理
        // （放宽 required 或写入排障摘要），此处固化当前约束以免静默退化。
        const err = buildMessage({
            role: 'tool',
            content: '',
            toolCallId: 'call_x',
        }).validateSync();

        expect(err?.errors.content).toBeInstanceOf(
            mongoose.Error.ValidatorError,
        );
    });
});

describe('ChatMessage 模型 — 工具调用字段', () => {
    it('toolCalls 可存动态参数结构（arguments 为 Mixed）', () => {
        const args = { new_title: 'X', nested: { deep: [1, 2] } };
        const doc = buildMessage({
            role: 'assistant',
            content: '好的',
            toolCalls: [
                { id: 'call_1', name: 'update_title', arguments: args },
            ],
        });

        expect(doc.validateSync()).toBeUndefined();
        expect(doc.toolCalls?.[0]?.id).toBe('call_1');
        expect(doc.toolCalls?.[0]?.name).toBe('update_title');
        expect(doc.toolCalls?.[0]?.arguments).toEqual(args);
    });

    it('toolCalls 元素不引入隐式 _id（存储形状与设计 §6.3 一致）', () => {
        const doc = buildMessage({
            role: 'assistant',
            toolCalls: [
                {
                    id: 'call_1',
                    name: 'update_title',
                    arguments: { new_title: 'X' },
                },
            ],
        });

        const plain = doc.toObject() as ExpandedChatMessage;

        expect(plain.toolCalls).toEqual([
            {
                id: 'call_1',
                name: 'update_title',
                arguments: { new_title: 'X' },
            },
        ]);
    });

    it('result.status: cancelled 合法（悬挂兜底合成态）', () => {
        const doc = buildMessage({
            role: 'tool',
            toolCallId: 'call_1',
            result: { status: 'cancelled', error: 'client disconnected' },
        });

        expect(doc.validateSync()).toBeUndefined();
    });

    it('result.status: foo 被 enum 拒绝', () => {
        const err = buildMessage({
            role: 'tool',
            toolCallId: 'call_1',
            result: { status: 'foo' },
        }).validateSync();

        expect(err?.errors['result.status']).toBeInstanceOf(
            mongoose.Error.ValidatorError,
        );
    });

    it.each(['chat', 'write'])('mode: %s 合法', (mode) => {
        expect(buildMessage({ mode }).validateSync()).toBeUndefined();
    });

    it('mode: foo 被 enum 拒绝', () => {
        const err = buildMessage({ mode: 'foo' }).validateSync();

        expect(err?.errors.mode).toBeInstanceOf(mongoose.Error.ValidatorError);
    });

    it('新增字段均为可选：既有落库形状缺省时校验通过且不落空值', () => {
        const doc = buildMessage({ role: 'user' });

        expect(doc.validateSync()).toBeUndefined();
        expect(doc.mode).toBeUndefined();
        expect(doc.noteId).toBeUndefined();
        expect(doc.toolCalls).toBeUndefined();
        expect(doc.toolCallId).toBeUndefined();
        // result 为嵌套路径：内存中会被实例化为空嵌套文档，落库时由 minimize 省略
        // （落库形状由下一条用例断言）
        expect(doc.result?.status).toBeUndefined();
        expect(doc.runId).toBeUndefined();
    });

    it('既有消息落库时不会多出 toolCalls: []（无工具时代文档形状不变）', () => {
        const plain = buildMessage({ role: 'assistant' }).toObject();

        expect(
            Object.keys(plain).filter((k) =>
                /^(toolCalls|result|mode|noteId|runId|toolCallId)$/.test(k),
            ),
        ).toEqual([]);
    });
});

describe('ChatMessage 模型 — 自审：未误改既有声明', () => {
    it('既有三个索引保持原样，且未新增索引', () => {
        const declared = ChatMessage.schema.indexes().map(([fields]) => fields);

        expect(declared).toContainEqual({ sessionId: 1 });
        expect(declared).toContainEqual({ timestamp: 1 });
        expect(declared).toContainEqual({ sessionId: 1, timestamp: -1 });
        expect(declared).toHaveLength(3);
    });

    it('未引入 display 字段（role: tool 即内部性判别符）', () => {
        const pathNames = Object.keys(ChatMessage.schema.paths);

        expect(pathNames.filter((name) => /display/i.test(name))).toEqual([]);
    });

    it('schema 暴露出全部新增字段路径', () => {
        const pathNames = Object.keys(ChatMessage.schema.paths);

        expect(pathNames).toEqual(
            expect.arrayContaining([
                'mode',
                'noteId',
                'toolCalls',
                'toolCallId',
                'result.status',
                'result.docHash',
                'result.titleAfter',
                'result.error',
                'runId',
            ]),
        );
    });
});

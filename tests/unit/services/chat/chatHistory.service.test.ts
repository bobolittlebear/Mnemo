/**
 * chatHistory.service 单元测试
 *
 * 测试目标：
 *   C1: endSession → Session.updateOne 参数为 { sessionId }, { $set: { status: 'archived' } }
 *   C2: clearAll → ChatMessage.updateMany 软删除 + Session.updateOne status → 'deleted'
 *   C3: clearAll 时 Session.updateOne reject → 不抛异常，ChatMessage.updateMany 正常执行
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖 ──

const {
    mockChatMessageUpdateMany,
    mockSessionUpdateOne,
    mockSessionEndTriggerEnd,
    mockSessionMemoryLifecycleDestroy,
} = vi.hoisted(() => ({
    mockChatMessageUpdateMany: vi.fn(),
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

beforeEach(() => {
    mockChatMessageUpdateMany.mockReset();
    mockSessionUpdateOne.mockReset();
    mockSessionEndTriggerEnd.mockReset();
    mockSessionMemoryLifecycleDestroy.mockReset();

    // 默认 resolve
    mockChatMessageUpdateMany.mockResolvedValue({ modifiedCount: 5 });
    mockSessionUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockSessionEndTriggerEnd.mockResolvedValue(undefined);
    mockSessionMemoryLifecycleDestroy.mockResolvedValue(undefined);
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
            expect(mockSessionMemoryLifecycleDestroy).toHaveBeenCalledTimes(
                1,
            );
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
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { createPipelineAdapter } from '@/services/memory/trigger/pipelineAdapter';
import type { MemoryPipelineContract } from '@/services/memory/trigger/pipelinePort';
import type { MessageSource } from '@/services/memory/trigger/messageSource';
import type { RawMessage } from '@/types/chat';

const mkMessage = (msgId: string): RawMessage =>
    ({
        msgId,
        role: 'user',
        content: `content-${msgId}`,
        timestamp: 1,
    }) as RawMessage;

describe('createPipelineAdapter', () => {
    let pipelineRun: ReturnType<typeof vi.fn>;
    let getMessages: ReturnType<typeof vi.fn>;
    let adapter: ReturnType<typeof createPipelineAdapter>;

    beforeEach(() => {
        pipelineRun = vi.fn().mockResolvedValue(undefined);
        getMessages = vi.fn();
        adapter = createPipelineAdapter({
            pipeline: { run: pipelineRun } as unknown as MemoryPipelineContract,
            messages: { getMessages } as unknown as MessageSource,
        });
    });

    it('happy path：先取消息，再以 (sessionId, messages) 调用真实服务', async () => {
        const msgs = [mkMessage('m1'), mkMessage('m2')];
        getMessages.mockResolvedValue(msgs);

        await adapter.run('sid-1');

        expect(getMessages).toHaveBeenCalledWith('sid-1');
        expect(getMessages).toHaveBeenCalledTimes(1);
        expect(pipelineRun).toHaveBeenCalledWith('sid-1', msgs);
        expect(pipelineRun).toHaveBeenCalledTimes(1);
    });

    it('edge case：消息来源返回空数组时仍以空数组调用服务（由服务内部决定空跑）', async () => {
        getMessages.mockResolvedValue([]);

        await adapter.run('sid-2');

        expect(getMessages).toHaveBeenCalledWith('sid-2');
        expect(pipelineRun).toHaveBeenCalledWith('sid-2', []);
    });

    it('错误处理：getMessages 抛错时向上抛出且不调用 pipeline.run', async () => {
        const boom = new Error('source boom');
        getMessages.mockRejectedValue(boom);

        await expect(adapter.run('sid-3')).rejects.toThrow('source boom');
        expect(pipelineRun).not.toHaveBeenCalled();
    });

    it('错误处理：pipeline.run 抛错时向上抛出', async () => {
        getMessages.mockResolvedValue([mkMessage('m1')]);
        const boom = new Error('pipeline boom');
        pipelineRun.mockRejectedValue(boom);

        await expect(adapter.run('sid-4')).rejects.toThrow('pipeline boom');
        expect(pipelineRun).toHaveBeenCalledWith('sid-4', [mkMessage('m1')]);
    });
});

import { describe, it, expect, vi } from 'vitest';

import {
    SessionEndTrigger,
    type TriggerResult,
} from '@/services/memory/trigger/sessionEndTrigger';

const completed = (terminalWritten: boolean): TriggerResult => ({
    status: 'COMPLETED',
    terminalWritten,
});

const skipped = (
    reason: 'LOCK' | 'TERMINAL' | 'PROCESSING',
): TriggerResult => ({ status: 'SKIPPED', reason });

type EndFn = (
    sessionId: string,
    layer: 'explicit' | 'timeout',
) => Promise<TriggerResult>;

function createCoordinator(fn: EndFn) {
    return { executeTerminalTrigger: vi.fn(fn) };
}

describe('SessionEndTrigger', () => {
    it('正常首次结束：透传 COMPLETED，参数为 explicit', async () => {
        const coordinator = createCoordinator(async () => completed(true));
        const trigger = new SessionEndTrigger({ coordinator });

        const result = await trigger.end('sid');

        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(1);
        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledWith(
            'sid',
            'explicit',
        );
        expect(result).toEqual({ status: 'COMPLETED', terminalWritten: true });
    });

    it('重复结束（SKIPPED/TERMINAL）：透传不抛错', async () => {
        const coordinator = createCoordinator(async () => skipped('TERMINAL'));
        const trigger = new SessionEndTrigger({ coordinator });

        const result = await trigger.end('sid');

        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ status: 'SKIPPED', reason: 'TERMINAL' });
    });

    it('并发中（SKIPPED/PROCESSING）：透传不抛错', async () => {
        const coordinator = createCoordinator(async () =>
            skipped('PROCESSING'),
        );
        const trigger = new SessionEndTrigger({ coordinator });

        const result = await trigger.end('sid');

        expect(result).toEqual({ status: 'SKIPPED', reason: 'PROCESSING' });
    });

    it('获锁失败（SKIPPED/LOCK）：透传', async () => {
        const coordinator = createCoordinator(async () => skipped('LOCK'));
        const trigger = new SessionEndTrigger({ coordinator });

        const result = await trigger.end('sid');

        expect(result).toEqual({ status: 'SKIPPED', reason: 'LOCK' });
    });

    it('coordinator 抛错时 end() 冒泡不吞错', async () => {
        const coordinator = createCoordinator(async () => {
            throw new Error('redis down');
        });
        const trigger = new SessionEndTrigger({ coordinator });

        await expect(trigger.end('sid')).rejects.toThrow('redis down');
        expect(coordinator.executeTerminalTrigger).toHaveBeenCalledTimes(1);
    });
});

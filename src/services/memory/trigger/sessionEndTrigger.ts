export type TriggerResult =
    | { status: 'COMPLETED'; terminalWritten: boolean }
    | { status: 'SKIPPED'; reason: 'LOCK' | 'TERMINAL' | 'PROCESSING' };

export interface TerminalTriggerCoordinator {
    executeTerminalTrigger(
        sessionId: string,
        layer: 'explicit' | 'timeout',
    ): Promise<TriggerResult>;
}

interface SessionEndTriggerDeps {
    coordinator: TerminalTriggerCoordinator;
}

export class SessionEndTrigger {
    private readonly coordinator: TerminalTriggerCoordinator;

    constructor(deps: SessionEndTriggerDeps) {
        this.coordinator = deps.coordinator;
    }

    async end(sessionId: string): Promise<TriggerResult> {
        return await this.coordinator.executeTerminalTrigger(sessionId, 'explicit');
    }
}

export default SessionEndTrigger;

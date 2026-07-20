import { createLogger } from '@/lib/logger';

const log = createLogger('ltm');

const MSG_COUNT_TTL_SECONDS = 60 * 60 * 24; //  24 小时
const DEFAULT_THRESHOLD = 20;

export type TriggerResult =
    | { status: 'COMPLETED'; terminalWritten: boolean }
    | { status: 'SKIPPED'; reason: 'LOCK' | 'TERMINAL' | 'PROCESSING' };

export interface TriggerCoordinator {
    triggerThreshold(sessionId: string): Promise<TriggerResult>;
}

export interface RedisClient {
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    del(...keys: string[]): Promise<number>;
}

interface MessageCounterDeps {
    coordinator: TriggerCoordinator;
    redis: RedisClient;
    threshold?: number;
}

const msgCountKey = (sessionId: string): string =>
    `memory:session:${sessionId}:msg_count`;

export class MessageCounter {
    private readonly coordinator: TriggerCoordinator;
    private readonly redis: RedisClient;
    private readonly threshold: number;

    constructor(deps: MessageCounterDeps) {
        this.coordinator = deps.coordinator;
        this.redis = deps.redis;
        this.threshold = deps.threshold ?? DEFAULT_THRESHOLD;
    }

    async record(sessionId: string): Promise<void> {
        const key = msgCountKey(sessionId);
        try {
            const count = await this.redis.incr(key);
            if (count === 1) {
                await this.redis.expire(key, MSG_COUNT_TTL_SECONDS);
            }
            if (count < this.threshold) return;

            let result: TriggerResult;
            try {
                result = await this.coordinator.triggerThreshold(sessionId);
            } catch (err) {
                log.error('L3 兜底触发调用失败', err as Error);
                return;
            }

            // L3 的 terminalWritten 恒为 false, status === 'COMPLETED'时提取必然执行完成
            if (result.status === 'COMPLETED' || result.reason === 'TERMINAL') {
                await this.redis.del(key);
            }
            // SKIPPED + LOCK | PROCESSING：不重置，等下次消息重试
        } catch (err) {
            log.error('L3 消息计数失败', err as Error);
        }
    }
}

export default MessageCounter;

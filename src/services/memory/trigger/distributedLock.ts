import crypto from 'crypto';
import type { RedisClientType } from 'redis';
import { memoryTriggerConfig } from './memoryTriggerConfig';

export const LOCK_TTL_MS = memoryTriggerConfig.lockTtlMs;

// 防止竞态条件
// 由于 Redis 是单线程处理请求的，在执行 Lua 脚本时，其他请求必须等待脚本完成。
// 这确保了在 GET和 DEL之间不会插入其他命令。
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

export class DistributedLock {
    constructor(private redis: RedisClientType) {}

    async acquire(key: string): Promise<string | null> {
        const token = crypto.randomUUID();
        const result = await this.redis.set(key, token, {
            NX: true,
            PX: LOCK_TTL_MS,
        });
        return result === 'OK' ? token : null;
    }

    async release(key: string, token: string): Promise<boolean> {
        const result = await this.redis.eval(RELEASE_SCRIPT, {
            keys: [key],
            arguments: [token],
        });
        return Number(result) === 1;
    }
}

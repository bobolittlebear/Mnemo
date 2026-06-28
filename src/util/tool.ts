import { SESSION_KEY_PREFIX } from './constant';
import { randomUUID } from 'crypto';

export function generateMemoryKey(userId: string) {
    return `${SESSION_KEY_PREFIX}${userId}`;
}
export function generateTraceId(): string {
    return randomUUID(); // 例如: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
}

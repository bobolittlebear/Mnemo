import { SESSION_PREFIX } from './constant';

export function generateMemoryKey(userId: string) {
    return `${SESSION_PREFIX}${userId}`;
}

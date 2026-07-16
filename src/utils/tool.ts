import {
    LAST_EXTRACTED_MSG_KEY_PREFIX,
    MESSAGE_ID_PREFIX,
    SESSION_KEY_PREFIX,
    TRACE_ID_PREFIX,
} from './constant';
import { randomUUID, createHash } from 'crypto';
import { v7 as uuidv7 } from 'uuid';

export function generateMemoryKey(userId: string) {
    return `${SESSION_KEY_PREFIX}${userId}`;
}

export function getUserIdFromMemoryKey(memoryKey: string) {
    if (memoryKey.startsWith(SESSION_KEY_PREFIX))
        return memoryKey.slice(SESSION_KEY_PREFIX.length);
    if (memoryKey.startsWith(LAST_EXTRACTED_MSG_KEY_PREFIX))
        return memoryKey.slice(LAST_EXTRACTED_MSG_KEY_PREFIX.length);
    return memoryKey;
}
export function generateTraceId(): string {
    return `${TRACE_ID_PREFIX}${randomUUID()}`; // 例如: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
}

export function generateMessageId(): string {
    return `${MESSAGE_ID_PREFIX}${uuidv7()}`;
}

export function safeStringify(obj: unknown): string {
    try {
        return JSON.stringify(obj);
    } catch {
        return '[Unserializable]';
    }
}

export function getExtractionKey(userId: string) {
    return `${LAST_EXTRACTED_MSG_KEY_PREFIX}${userId}`;
}

export function getNormalizationProps(model: string) {
    // 这些模型在输出向量时，默认已经进行了 L2 归一化处理
    return ![
        'text-embedding-3-small',
        'text-embedding-3-large',
        'text-embedding-v4',
    ].includes(model);
}

/**
 * 生成文本的 SHA-256 哈希值，用于精确去重
 */
export function generateContentHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 输出 YYYY-MM-DD HH:mm:ss 格式日期
 * @param date
 * @returns
 */
export function formatDateTime(date: Date) {
    if (!date || !(date instanceof Date)) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const M = pad(date.getMonth() + 1); // 月份从0开始
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const m = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `${y}-${M}-${d} ${h}:${m}:${s}`;
}

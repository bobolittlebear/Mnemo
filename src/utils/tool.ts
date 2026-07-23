import { randomUUID, createHash } from 'crypto';
import { v7 as uuidv7 } from 'uuid';

// 记忆管理会话标识 session key
export function generateSessionKey(sessionId: string) {
    return `quick_note:session:${sessionId}`;
}

export function generateTraceId(): string {
    return `trace-${randomUUID()}`;
}

export function generateMessageId(): string {
    return `msg-${uuidv7()}`;
}

export function safeStringify(obj: unknown): string {
    try {
        return JSON.stringify(obj);
    } catch {
        return '[Unserializable]';
    }
}

export function getCursorKey(sessionId: string) {
    return `memory:session:${sessionId}:cursor`;
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

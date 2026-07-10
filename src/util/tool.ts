import { LAST_EXTRACTED_MSG_KEY_PREFIX, SESSION_KEY_PREFIX } from './constant';
import { randomUUID, createHash } from 'crypto';

export function generateMemoryKey(userId: string) {
    return `${SESSION_KEY_PREFIX}${userId}`;
}
export function generateTraceId(): string {
    return randomUUID(); // 例如: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
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

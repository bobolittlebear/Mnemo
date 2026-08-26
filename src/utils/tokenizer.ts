// src/utils/tokenizer.ts
import { get_encoding, Tiktoken } from 'tiktoken';
import { cut } from 'jieba-wasm';

let encoder: Tiktoken | null = null;

/**
 * 获取单例 encoder，避免重复加载 WASM 模块
 */
export function getEncoder(): Tiktoken {
    if (!encoder) {
        encoder = get_encoding('cl100k_base');
    }
    return encoder;
}

/**
 * 精确计算 token 数量
 * @param text 输入文本
 * @returns token 数
 */
export function countTokens(text: string): number {
    if (!text) return 0;
    return getEncoder().encode(text).length;
}

/**
 * 按 token 上限截断文本（安全边界）
 * @param text 原始文本
 * @param maxTokens 最大允许 token 数
 * @returns 截断后的文本
 */
export function truncateByTokens(text: string, maxTokens: number): string {
    const enc = getEncoder();
    const tokens = enc.encode(text);
    if (tokens.length <= maxTokens) return text;

    const truncatedTokens = tokens.slice(0, maxTokens);

    // tiktoken 的 decode 返回 Uint8Array，需用 TextDecoder 转为 string
    return new TextDecoder().decode(enc.decode(truncatedTokens));
}

/**
 * 中文分词：将输入文本拆分为空格分隔的词序列，用于全文检索索引。
 *
 * @param text - 待分词文本
 * @returns 空格分隔的词序列；空字符串输入返回空串；分词异常时降级返回原文
 */
export function tokenize(text: string): string {
    if (!text) return '';
    try {
        const words = cut(text);
        return words.join(' ');
    } catch {
        // 降级：分词失败不阻塞主流程，返回原文
        return text;
    }
}

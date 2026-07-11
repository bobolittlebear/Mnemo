// src/utils/tokenizer.ts
import { get_encoding, Tiktoken } from 'tiktoken';

let encoder: Tiktoken | null = null;

/**
 * 获取单例 encoder，避免重复加载 WASM 模块
 */
function getEncoder(): Tiktoken {
    // # 方式二：通过模型名称自动获取对应编码器
    // enc = tiktoken.encoding_for_model("gpt-4")
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

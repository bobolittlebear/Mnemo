// src/utils/tokenizer.ts
import { get_encoding, Tiktoken } from 'tiktoken';
import { cut, add_word } from 'jieba-wasm';
import { createLogger } from '@/lib/logger';
import { DOMAIN_WORDS } from '@/utils/domainWords';

const log = createLogger('rag');

let encoder: Tiktoken | null = null;

/** 领域词典是否已注册（模块级一次性标志，保证重复调用幂等） */
let domainWordsRegistered = false;

/**
 * 注册 Mnemo 领域词典：把专有名词（模块名 / 字段名 / 内部黑话）预置进 jieba 词表，
 * 避免被默认词表切碎。注册失败仅告警不抛错——tokenize 侧仍有 cut 降级兜底。
 */
function registerDomainWords(): void {
    if (domainWordsRegistered) return;
    domainWordsRegistered = true;
    let failed = 0;
    for (const word of DOMAIN_WORDS) {
        try {
            add_word(word);
        } catch (error) {
            failed++;
            log.warn('jieba 领域词典注册失败（跳过该词，不影响分词降级）', {
                word,
                error: error as Error,
            });
        }
    }
    log.info('jieba 领域词典注册完成', {
        registered: DOMAIN_WORDS.length - failed,
        failed,
    });
}

// 模块加载即注册：所有入库 / 查询分词均经本模块，据此保证在 tokenize() 被任何调用方
// 使用前词典已就绪，避免「入库加了、查询没加」的口径漂移。
registerDomainWords();

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

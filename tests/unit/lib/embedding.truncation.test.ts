/**
 * embedding 输入上限回归（M2 修正配套）
 *
 * 背景：M2 撤销了「入库按 category 上限截断 content」，此后超长 content 会原样入库。
 * 本用例锁死唯一剩下的那道截断——embedding API 的 8191 硬上限（EMBEDDING_CONFIG.MAX_TOKENS），
 * 它只与供应商限制有关、不因 category 放大或缩小。
 *
 * Mock 依赖：AI 客户端、logger
 * 真实逻辑：generateEmbeddings 的 trim → 按 MAX_TOKENS 截断 → 分批
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock, loggerMock } = vi.hoisted(() => ({
    createMock: vi.fn(),
    loggerMock: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => loggerMock }));

vi.mock('@/services/core/llm', () => ({
    getAIApi: () => ({ embeddings: { create: createMock } }),
}));

import { generateEmbeddings } from '@/lib/embedding';
import {
    countTokens,
    truncateByTokens,
} from '@/utils/tokenizer';
import { EMBEDDING_CONFIG, EMBEDDING_MODEL } from '@/utils/config';

beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({
        usage: { total_tokens: 7 },
        data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
    });
});

describe('generateEmbeddings 输入截断', () => {
    it('happy：常规长度文本原样送 API，不做任何截断', async () => {
        const text = '用户偏好喝美式咖啡。';
        await generateEmbeddings(text);

        expect(countTokens(text)).toBeLessThanOrEqual(EMBEDDING_CONFIG.MAX_TOKENS);
        const arg = createMock.mock.calls[0]![0];
        expect(arg.model).toBe(EMBEDDING_MODEL);
        expect(arg.input).toEqual([text]);
    });

    it('边界：超 8191 token 的文本送 API 前截到上限，与 category 无关', async () => {
        const unit = '这是一段会反复追加的超长内容。';
        let text = unit;
        while (countTokens(text) <= EMBEDDING_CONFIG.MAX_TOKENS) text += unit;

        // 前置：原文确实超上限，否则本用例什么都没验证
        expect(countTokens(text)).toBeGreaterThan(
            EMBEDDING_CONFIG.MAX_TOKENS,
        );

        await generateEmbeddings(text);

        const sent = createMock.mock.calls[0]![0].input[0] as string;
        expect(countTokens(sent)).toBeLessThanOrEqual(
            EMBEDDING_CONFIG.MAX_TOKENS,
        );
        expect(sent).toBe(
            truncateByTokens(text, EMBEDDING_CONFIG.MAX_TOKENS),
        );
        expect(sent.length).toBeLessThan(text.length);
    });
});

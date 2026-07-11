/**
 * ExtractionService 单元测试
 *
 * 测试目标：LLM 提取 + 文本清洗 + JSON 解析
 * Mock 依赖：createChat（LLM）
 * 真实逻辑：cleanText、parseFacts、置信度/长度过滤
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──
vi.mock('@/services/ai.service', () => ({
  createChat: vi.fn(),
  createStreamChat: vi.fn(),
  extractUsageFromChunk: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/utils/constant', () => ({
  EXTRACTION_PROMPT: '提取以下对话中的事实:\n{{CONVERSATION}}',
}));

// ── 引入被测模块（在 Mock 之后）──
import { createChat } from '@/services/ai.service';
import MemoryExtractionService from '@/services/memory/memoryExtraction.service';
import * as fixtures from '../../helpers/fixtures';

const mockedCreateChat = vi.mocked(createChat);
const service = MemoryExtractionService;

// ── 辅助：反射调用 private 方法 ──
const internal = service as any;

beforeEach(() => {
  mockedCreateChat.mockReset();
});

describe('ExtractionService', () => {
  it('E1 - 空消息列表应返回空数组且不调 LLM', async () => {
    const result = await service.extractFacts([]);
    expect(result).toEqual([]);
    expect(mockedCreateChat).not.toHaveBeenCalled();
  });

  it('E2 - 正常对话应提取出有效事实', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmNormalResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('用户在准备前端面试，重点复习 React 和 TypeScript');
    expect(result[0].confidence).toBe(0.9);
    expect(mockedCreateChat).toHaveBeenCalledTimes(1);

    // 断言 LLM 收到的参数：role + 对话内容已注入 prompt
    const callArgs = mockedCreateChat.mock.calls[0];
    expect(callArgs[0][0].role).toBe('system');
    expect(callArgs[0][0].content).toContain('前端面试');
    expect(callArgs[0][0].content).toContain('React');
    expect(callArgs[1]).toEqual({ temperature: 0.1 });
  });

  it('E3 - LLM 返回空 facts 数组时应返回空数组', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmEmptyFactsResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toEqual([]);
  });

  it('E4 - LLM 返回非法 JSON 时 parseFacts 应返回空数组不抛异常', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmInvalidJsonResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toEqual([]);
  });

  it('E5 - LLM 返回 markdown 包裹的 JSON 应正确解析', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmMarkdownWrappedResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('这是一条测试事实');
  });

  it('E6 - confidence < 0.6 的事实应被过滤', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmLowConfidenceResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });

  it('E7 - 清洗后长度 < 5 的事实应被过滤', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmShortContentResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('正常长度的事实内容');
  });

  it('E8a - cleanText 应合并多余空白', () => {
    const input = '  这段   内容\t\n有\n\n多余空白  ';
    const result = internal.cleanText(input);
    expect(result).not.toMatch(/\s{2,}/);
    expect(result.trim()).toBe(result);
  });

  it('E8b - cleanText 应去除控制字符', () => {
    const input = '带有\x00控制\x01字符\x7f的内容';
    const result = internal.cleanText(input);
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x01');
    expect(result).not.toContain('\x7f');
  });

  it('E9 - LLM 调用失败应抛出原始错误', async () => {
    mockedCreateChat.mockRejectedValue(new Error('LLM API timeout'));
    await expect(service.extractFacts(fixtures.mockMessages)).rejects.toThrow('LLM API timeout');
  });

  it('E10 - 字段类型错误的 fact 应被过滤', async () => {
    mockedCreateChat.mockResolvedValue(fixtures.llmWrongTypeResponse);
    const result = await service.extractFacts(fixtures.mockMessages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('这是一条正常的事实');
  });

  it('E11a - parseFacts 解析正常 JSON', () => {
    const raw = JSON.stringify({ facts: [{ content: '测试', confidence: 0.9 }] });
    const result = internal.parseFacts(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ content: '测试', confidence: 0.9 });
  });

  it('E11b - parseFacts 解析空字符串返回空数组', () => {
    expect(internal.parseFacts('')).toEqual([]);
  });

  it('E11c - parseFacts 解析不含 facts 字段的 JSON 返回空数组', () => {
    expect(internal.parseFacts('{"other": "data"}')).toEqual([]);
  });

  it('E11d - parseFacts facts 不是数组时返回空数组', () => {
    expect(internal.parseFacts('{"facts": "not_an_array"}')).toEqual([]);
  });
});

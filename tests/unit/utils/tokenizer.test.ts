/**
 * tokenizer 单元测试
 *
 * 测试目标：countTokens 精确计数、truncateByTokens 按上限截断、tokenize 领域词典分词
 * Mock 依赖：tiktoken（WASM 模块，纯 IO）、@/lib/logger（避免 File transport 写盘）
 * 真实逻辑：getEncoder 单例、token 编码/解码流程、jieba 领域词典注册与分词
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──
const mockEncode = vi.fn();
const mockDecode = vi.fn();

vi.mock('tiktoken', () => ({
  get_encoding: vi.fn(() => ({
    encode: mockEncode,
    decode: mockDecode,
  })),
}));

// 单测禁止 IO：tokenizer 模块加载时会注册领域词典并打日志，mock 掉 logger 防止写日志文件
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── 引入被测模块（在 Mock 之后）──
import { countTokens, truncateByTokens, tokenize } from '@/utils/tokenizer';

// ── 辅助：生成指定长度的模拟 token 数组 ──
function mockTokens(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：每个字符映射一个 token
  mockEncode.mockImplementation((text: string) => mockTokens(text.length));
  mockDecode.mockImplementation((tokens: number[]) => {
    // 模拟 decode：返回 Uint8Array
    const str = 'x'.repeat(tokens.length);
    return new TextEncoder().encode(str);
  });
});

describe('countTokens', () => {
  // ── Happy path ──
  it('T1 - 普通英文文本应返回精确 token 数', () => {
    const text = 'hello world';
    mockEncode.mockReturnValue(mockTokens(5));
    const result = countTokens(text);
    expect(result).toBe(5);
    expect(mockEncode).toHaveBeenCalledWith(text);
    expect(mockEncode).toHaveBeenCalledTimes(1);
  });

  it('T2 - 中文文本应返回精确 token 数', () => {
    const text = '你好世界';
    mockEncode.mockReturnValue(mockTokens(8));
    const result = countTokens(text);
    expect(result).toBe(8);
  });

  it('T3 - 混合中英文 + 标点应返回精确 token 数', () => {
    const text = 'Hello 你好！world.';
    mockEncode.mockReturnValue(mockTokens(12));
    const result = countTokens(text);
    expect(result).toBe(12);
  });

  // ── Edge cases ──
  it('T4 - 空字符串应返回 0 且不调用 encoder', () => {
    const result = countTokens('');
    expect(result).toBe(0);
    expect(mockEncode).not.toHaveBeenCalled();
  });

  it('T5 - 纯空格字符串应返回精确 token 数', () => {
    const text = '   ';
    mockEncode.mockReturnValue(mockTokens(3));
    const result = countTokens(text);
    expect(result).toBe(3);
  });

  it('T6 - 极长文本不应超时或溢出', () => {
  const text = 'x'.repeat(50000);
  const MOCK_TOKEN_COUNT = 12000; // 与真实值无关，仅验证透传
  mockEncode.mockReturnValue(mockTokens(MOCK_TOKEN_COUNT));

  const result = countTokens(text);

  expect(result).toBe(MOCK_TOKEN_COUNT);
  expect(mockEncode).toHaveBeenCalledWith(text);
});

});

describe('truncateByTokens', () => {
  // ── Happy path ──
  it('T8 - token 数未超上限应返回原文', () => {
    const text = 'short text';
    mockEncode.mockReturnValue(mockTokens(2));
    const result = truncateByTokens(text, 10);
    expect(result).toBe(text);
    expect(mockDecode).not.toHaveBeenCalled();
  });

  it('T9 - token 数刚好等于上限应返回原文', () => {
    const text = 'exact limit';
    mockEncode.mockReturnValue(mockTokens(5));
    const result = truncateByTokens(text, 5);
    expect(result).toBe(text);
    expect(mockDecode).not.toHaveBeenCalled();
  });

  it('T10 - token 数超过上限应截断并解码返回', () => {
    const text = 'this is a very long text that exceeds the limit';
    // 假设原文 15 个 token，上限 5
    mockEncode.mockReturnValue(mockTokens(15));
    const result = truncateByTokens(text, 5);
    // encode 被调用一次
    expect(mockEncode).toHaveBeenCalledWith(text);
    expect(mockEncode).toHaveBeenCalledTimes(1);
    // decode 被调用，传入前 5 个 token
    expect(mockDecode).toHaveBeenCalledWith(mockTokens(5));
    expect(mockDecode).toHaveBeenCalledTimes(1);
  });

  // ── Edge cases ──
  it('T11 - 空字符串应返回空字符串', () => {
    mockEncode.mockReturnValue([]);
    expect(truncateByTokens('', 10)).toBe('');
    expect(mockDecode).not.toHaveBeenCalled();
  });

  it('T12 - maxTokens 为 0 时应截断为空', () => {
    mockEncode.mockReturnValue(mockTokens(5));
    expect(truncateByTokens('hello', 0)).toBe('');
    // tokens.length (5) > maxTokens (0)，进入截断分支
    expect(mockDecode).toHaveBeenCalledWith([]);
    expect(mockDecode).toHaveBeenCalledTimes(1);
  });

  it('T13 - 截断后 decode 结果应为原文前缀', () => {
    const text = 'Hello World This Is A Long Sentence';
    mockEncode.mockImplementation((t: string) => mockTokens(t.split(' ').length));
    // 7 个词 → 7 个 token，截断到 3
    const truncated = new TextEncoder().encode('Hello World This');
    mockDecode.mockReturnValue(truncated);
    expect(truncateByTokens(text, 3)).toBe('Hello World This');
  });
});

// tokenize 输出为空格分隔的词序列（入库 / 查询共用），断言时 split 成数组验证「整词」而非子串
function tokenizeToWords(text: string): string[] {
  return tokenize(text).split(' ');
}

// 注：M1 的领域词典已证伪并置空（见 src/utils/domainWords.ts），故这里只锁 tokenize 的
// 基础行为（空格连接 / 空串 / 降级不抛错 / 快照）。词典注册出口仍在，M2 复用时可再加回词典用例。
describe('tokenize', () => {
  // ── Happy path ──
  it('HP1 - 普通中文文本仍正常分词', () => {
    const tokens = tokenizeToWords('用户很久没说话');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join('')).toBe('用户很久没说话');
  });

  // ── Edge cases ──
  it('边界1 - 空串返回空串', () => {
    expect(tokenize('')).toBe('');
  });

  it('边界2 - 未登录词按 jieba 默认切分且不抛错', () => {
    const tokens = tokenizeToWords('今天天气好');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join('')).toBe('今天天气好');
  });

  // ── 快照：锁定分词行为，后续词典变更会触发快照审查 ──
  it('快照 - 中英混合文本分词结果稳定', () => {
    expect(tokenize('Redis 缓存穿透与乐观锁')).toMatchSnapshot();
  });
});

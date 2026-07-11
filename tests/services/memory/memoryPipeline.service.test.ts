/**
 * PipelineService 单元测试
 *
 * 测试目标：编排流程的顺序控制、条件分支、异常传播
 * Mock 依赖：ExtractionService、IngestionService、generateEmbeddings、STM、MemoryFact
 * 真实逻辑：编排 5 步流程、幂等判断、空结果短路、标记更新时机
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──

vi.mock('@/services/memory/memoryExtraction.service', () => ({
  default: { extractFacts: vi.fn() },
}));

vi.mock('@/services/memory/memoryIngestion.service', () => ({
  ingestMemoryFacts: vi.fn(),
}));

vi.mock('@/utils/shortTermMemory', () => ({
  default: { setLastExtractedMsgId: vi.fn() },
}));

vi.mock('@/lib/embedding', () => ({
  generateEmbeddings: vi.fn(),
}));

vi.mock('@/models/MemoryFact', () => ({
  MemoryFact: { findOne: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('@/utils/tool', () => ({
  getExtractionKey: (sessionId: string) => `mnemo:extraction:${sessionId}`,
  generateContentHash: (content: string) => `hash_${content}`,
}));

// ── 引入被测模块 ──
import memoryExtractionService from '@/services/memory/memoryExtraction.service';
import { ingestMemoryFacts } from '@/services/memory/memoryIngestion.service';
import STM from '@/utils/shortTermMemory';
import { generateEmbeddings } from '@/lib/embedding';
import { MemoryFact } from '@/models/MemoryFact';
import MemoryPipelineService from '@/services/memory/memoryPipeline.service';
import * as fixtures from '../../helpers/fixtures';

// ── 获取 Mock 引用 ──
const mockedExtractFacts = vi.mocked(memoryExtractionService.extractFacts);
const mockedIngestMemoryFacts = vi.mocked(ingestMemoryFacts);
const mockedSetLastExtractedMsgId = vi.mocked(STM.setLastExtractedMsgId);
const mockedGenerateEmbeddings = vi.mocked(generateEmbeddings);
const mockedFindOne = vi.mocked(MemoryFact.findOne);

const pipeline = MemoryPipelineService;

beforeEach(() => {
  vi.clearAllMocks();
});

function mockFindOneLean(resolveValue: any) {
  mockedFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(resolveValue),
  } as any);
}

function setupHappyPath() {
  mockFindOneLean(null);
  mockedExtractFacts.mockResolvedValue([
    { content: '事实1', confidence: 0.9 },
    { content: '事实2', confidence: 0.85 },
  ]);
  mockedGenerateEmbeddings.mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
    totalTokens: 0,
  });
  mockedIngestMemoryFacts.mockResolvedValue({
    totalProcessed: 2, inserted: 2, updated: 0, skipped: 0,
  });
  mockedSetLastExtractedMsgId.mockResolvedValue(undefined);
}

describe('PipelineService', () => {
  it('P1 - 空消息列表应立即返回全 0，不查 DB 不调 LLM', async () => {
    const result = await pipeline.run(fixtures.mockSessionId, []);
    expect(result).toEqual({ totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 });
    expect(mockedFindOne).not.toHaveBeenCalled();
    expect(mockedExtractFacts).not.toHaveBeenCalled();
    expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
    expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
    expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
  });

  it('P2 - 已提取过的消息应跳过 LLM，更新标记，返回全 0', async () => {
    mockFindOneLean({ _id: 'existing-fact-id', memoryKey: fixtures.mockMemoryKey });
    mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

    const result = await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
    expect(result).toEqual({ totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 });
    expect(mockedExtractFacts).not.toHaveBeenCalled();
    expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
    expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
    expect(mockedSetLastExtractedMsgId).toHaveBeenCalledWith(fixtures.mockSessionId, 'msg-003');
  });

  it('P3 - LLM 提取 0 条事实应短路，跳过向量和入库，但更新标记', async () => {
    mockFindOneLean(null);
    mockedExtractFacts.mockResolvedValue([]);
    mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

    const result = await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
    expect(result).toEqual({ totalProcessed: 0, inserted: 0, updated: 0, skipped: 0 });
    expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
    expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
    expect(mockedSetLastExtractedMsgId).toHaveBeenCalledWith(fixtures.mockSessionId, 'msg-003');
  });

  it('P4 - 全链路成功应走完 5 步并返回正确结果', async () => {
    setupHappyPath();
    const result = await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
    expect(result).toEqual({ totalProcessed: 2, inserted: 2, updated: 0, skipped: 0 });
    expect(vi.mocked(mockedFindOne)).toHaveBeenCalledTimes(1);
    expect(mockedExtractFacts).toHaveBeenCalledTimes(1);
    expect(mockedGenerateEmbeddings).toHaveBeenCalledTimes(1);
    expect(mockedIngestMemoryFacts).toHaveBeenCalledTimes(1);
    expect(mockedSetLastExtractedMsgId).toHaveBeenCalledTimes(1);
    expect(mockedGenerateEmbeddings).toHaveBeenCalledWith(['事实1', '事实2']);
  });

  it('P5 - LLM 提取失败应抛出异常且不更新 Redis 标记', async () => {
    mockFindOneLean(null);
    mockedExtractFacts.mockRejectedValue(new Error('LLM API timeout'));
    await expect(pipeline.run(fixtures.mockSessionId, fixtures.mockMessages)).rejects.toThrow('LLM API timeout');
    expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
    expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
    expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
  });

  it('P6 - 向量化失败应抛出异常且不更新 Redis 标记', async () => {
    mockFindOneLean(null);
    mockedExtractFacts.mockResolvedValue([{ content: '事实1', confidence: 0.9 }]);
    mockedGenerateEmbeddings.mockRejectedValue(new Error('Embedding API error'));
    await expect(pipeline.run(fixtures.mockSessionId, fixtures.mockMessages)).rejects.toThrow('Embedding API error');
    expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
    expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
  });

  it('P7 - 入库失败应抛出异常且不更新 Redis 标记', async () => {
    mockFindOneLean(null);
    mockedExtractFacts.mockResolvedValue([{ content: '事实1', confidence: 0.9 }]);
    mockedGenerateEmbeddings.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]], totalTokens: 0 });
    mockedIngestMemoryFacts.mockRejectedValue(new Error('MongoDB connection lost'));
    await expect(pipeline.run(fixtures.mockSessionId, fixtures.mockMessages)).rejects.toThrow('MongoDB connection lost');
    expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
  });

  it('P8 - setLastExtractedMsgId 应在所有步骤成功后才调用', async () => {
    setupHappyPath();
    await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
    const callOrder = [
      mockedFindOne.mock.invocationCallOrder[0],
      mockedExtractFacts.mock.invocationCallOrder[0],
      mockedGenerateEmbeddings.mock.invocationCallOrder[0],
      mockedIngestMemoryFacts.mock.invocationCallOrder[0],
      mockedSetLastExtractedMsgId.mock.invocationCallOrder[0],
    ];
    for (let i = 0; i < callOrder.length - 1; i++) {
      expect(callOrder[i]).toBeLessThan(callOrder[i + 1]!);
    }
  });

  it('P9 - 幂等检查应使用 memoryKey + sourceMessageIds 查询', async () => {
    setupHappyPath();
    await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
    expect(mockedFindOne).toHaveBeenCalledWith({
      memoryKey: fixtures.mockMemoryKey,
      sourceMessageIds: { $in: ['msg-001', 'msg-002', 'msg-003'] },
    });
  });

  it('P10 - 传给 ingestMemoryFacts 的 context 应包含正确的 memoryKey 和 sourceIds', async () => {
    setupHappyPath();
    await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
    const ingestCallArgs = mockedIngestMemoryFacts.mock.calls[0];
    const facts = ingestCallArgs![0];
    const context = ingestCallArgs![1];
    expect(context.memoryKey).toBe(fixtures.mockMemoryKey);
    expect(context.sourceMessageIds).toEqual(['msg-001', 'msg-002', 'msg-003']);
    expect(facts[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(facts[1].embedding).toEqual([0.4, 0.5, 0.6]);
  });
});

/**
 * IngestionService 单元测试
 *
 * 测试目标：contentHash 去重 + bulkWrite upsert 入库
 * Mock 依赖：MemoryFact.bulkWrite（MongoDB）
 * 真实逻辑：operations 构建、contentHash 计算、结果解析
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖（使用 @ 别名，与源码 import 路径完全一致）──
vi.mock('@/models/MemoryFact', () => ({
  MemoryFact: {
    bulkWrite: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// 注意：源码中写的是 @/utils/tool（带 s），实际目录是 src/util/
// mock 路径必须与源码 import 路径一致才能生效
vi.mock('@/utils/tool', () => ({
  generateContentHash: (content: string) => `hash_${content}`,
  getExtractionKey: (sessionId: string) => `mnemo:extraction:${sessionId}`,
}));

// ── 引入被测模块 ──
import { MemoryFact } from '@/models/MemoryFact';
import { ingestMemoryFacts } from '@/services/memory/memoryIngestion.service';
import * as fixtures from '../../helpers/fixtures';
import type { EmbeddedFact, IngestionContext } from '@/types/memory';

const mockedBulkWrite = vi.mocked(MemoryFact.bulkWrite);

// ── 测试数据构造 ──
function makeFacts(count: number): EmbeddedFact[] {
  return Array.from({ length: count }, (_, i) => ({
    content: `事实内容${i + 1}`,
    confidence: 0.8 + i * 0.01,
    embedding: [0.1 * (i + 1), 0.2 * (i + 1), 0.3 * (i + 1)],
  }));
}

const ctx: IngestionContext = {
  memoryKey: fixtures.mockMemoryKey,
  sourceMessageIds: ['msg-001', 'msg-002', 'msg-003'],
};

beforeEach(() => {
  mockedBulkWrite.mockReset();
});

describe('IngestionService', () => {
  it('I1 - 正常入库 3 条事实应返回 inserted:3', async () => {
    mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
    const result = await ingestMemoryFacts(makeFacts(3), ctx);
    expect(result.totalProcessed).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(mockedBulkWrite).toHaveBeenCalledTimes(1);
  });

  it('I2 - 空数组应跳过 bulkWrite 返回全 0', async () => {
    const result = await ingestMemoryFacts([], ctx);
    expect(result.totalProcessed).toBe(0);
    expect(result.inserted).toBe(0);
    expect(mockedBulkWrite).not.toHaveBeenCalled();
  });

  it('I2b - 单条事实应正确入库', async () => {
    mockedBulkWrite.mockResolvedValue({
      insertedCount: 0, modifiedCount: 0, upsertedCount: 1,
      deletedCount: 0, matchedCount: 0,
    } as any);
    const result = await ingestMemoryFacts(makeFacts(1), ctx);
    expect(result.totalProcessed).toBe(1);
    expect(result.inserted).toBe(1);
    expect(mockedBulkWrite).toHaveBeenCalledTimes(1);
  });

  it('I3 - 部分更新应正确统计 inserted 和 updated', async () => {
    mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteUpdateResult as any);
    const result = await ingestMemoryFacts(makeFacts(3), ctx);
    expect(result.totalProcessed).toBe(3);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(2);
  });

  it('I4 - bulkWrite 失败应抛出原始错误', async () => {
    mockedBulkWrite.mockRejectedValue(new Error('MongoDB connection lost'));
    await expect(ingestMemoryFacts(makeFacts(2), ctx)).rejects.toThrow('MongoDB connection lost');
  });

  it('I5 - 每条 fact 应生成一个 updateOne with upsert operation', async () => {
    mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
    const facts = makeFacts(2);
    await ingestMemoryFacts(facts, ctx);

    const operations = mockedBulkWrite.mock.calls[0]?.[0] as any[];
    expect(operations).toHaveLength(2);

    for (const op of operations) {
      expect(op.updateOne.upsert).toBe(true);
      expect(op.updateOne.filter).toHaveProperty('contentHash');
      expect(op.updateOne.filter).toHaveProperty('memoryKey', fixtures.mockMemoryKey);
      expect(op.updateOne.update.$set).toHaveProperty('content');
      expect(op.updateOne.update.$set).toHaveProperty('embedding');
      expect(op.updateOne.update.$set).toHaveProperty('confidence');
      // sourceMessageIds 在 $addToSet 中，不在 $set 中
      expect(op.updateOne.update.$addToSet).toHaveProperty('sourceMessageIds');
    }
  });

  it('I6 - memoryKey 和 sourceMessageIds 应从 context 注入每条 operation', async () => {
    mockedBulkWrite.mockResolvedValue(fixtures.mockBulkWriteResult as any);
    await ingestMemoryFacts(makeFacts(1), ctx);

    const op = (mockedBulkWrite.mock.calls[0]?.[0] as any[])[0];
    expect(op.updateOne.filter.memoryKey).toBe(fixtures.mockMemoryKey);
    // sourceMessageIds 通过 $addToSet + $each 注入
    expect(op.updateOne.update.$addToSet.sourceMessageIds).toEqual({
      $each: ['msg-001', 'msg-002', 'msg-003'],
    });
  });

  it('I7 - upsert 的文档应计入 inserted 而非忽略', async () => {
    mockedBulkWrite.mockResolvedValue({
      insertedCount: 0, modifiedCount: 0, upsertedCount: 3,
      deletedCount: 0, matchedCount: 0,
    } as any);
    const result = await ingestMemoryFacts(makeFacts(3), ctx);
    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
  });
});

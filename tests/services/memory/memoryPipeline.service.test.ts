/**
 * PipelineService 单元测试
 *
 * 测试目标：编排流程的两级去重（游标 + DB）、条件分支、异常传播
 * Mock 依赖：ExtractionService、IngestionService、generateEmbeddings、STM、MemoryFact
 * 真实逻辑：编排 5 步流程、游标快速过滤、DB 精确去重、空结果短路、标记更新时机
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
    default: { setLastExtractedMsgId: vi.fn(), getLastExtractedMsgId: vi.fn() },
}));

vi.mock('@/lib/embedding', () => ({
    generateEmbeddings: vi.fn(),
}));

vi.mock('@/models/MemoryFact', () => ({
    MemoryFact: { find: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
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
import { v7 as uuid } from 'uuid';

// ── 获取 Mock 引用 ──
const mockedExtractFacts = vi.mocked(memoryExtractionService.extractFacts);
const mockedIngestMemoryFacts = vi.mocked(ingestMemoryFacts);
const mockedSetLastExtractedMsgId = vi.mocked(STM.setLastExtractedMsgId);
const mockedGetLastExtractedMsgId = vi.mocked(STM.getLastExtractedMsgId);
const mockedGenerateEmbeddings = vi.mocked(generateEmbeddings);
const mockedFind = vi.mocked(MemoryFact.find);

const pipeline = MemoryPipelineService;

beforeEach(() => {
    vi.clearAllMocks();
});

/** Mock MemoryFact.find().select().lean() 链式调用 */
function mockFindLean(docs: Array<{ sourceMessageIds: string[] }>) {
    mockedFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(docs),
        }),
    } as any);
}

/** 设置全链路成功默认 Mock：游标无记录、DB 无重复、LLM 2 条事实、向量成功、入库成功 */
function setupHappyPath() {
    mockedGetLastExtractedMsgId.mockResolvedValue(null); // 无游标记录
    mockFindLean([]); // DB 无重复
    mockedExtractFacts.mockResolvedValue([
        { content: '事实1', confidence: 0.9, sourceMessageIds: ['msg-001'] },
        { content: '事实2', confidence: 0.85, sourceMessageIds: ['msg-003'] },
    ]);
    mockedGenerateEmbeddings.mockResolvedValue({
        embeddings: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
        ],
        totalTokens: 0,
    });
    mockedIngestMemoryFacts.mockResolvedValue({
        totalProcessed: 2,
        inserted: 2,
        updated: 0,
        skipped: 0,
    });
    mockedSetLastExtractedMsgId.mockResolvedValue(undefined);
}

describe('PipelineService', () => {
    // ──────────────────── P1: 空消息短路 ────────────────────

    it('P1 - 空消息列表应立即返回全 0，不调任何依赖', async () => {
        const result = await pipeline.run(fixtures.mockSessionId, []);
        expect(result).toEqual({
            totalProcessed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
        });
        expect(mockedGetLastExtractedMsgId).not.toHaveBeenCalled();
        expect(mockedFind).not.toHaveBeenCalled();
        expect(mockedExtractFacts).not.toHaveBeenCalled();
        expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
        expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
    });

    // ──────────────────── P2: 游标快速过滤（一级防御）────────────────────

    it('P2 - 游标 >= 最后消息 ID 时跳过整批，不查 DB 不调 LLM', async () => {
        // 游标已覆盖最后一条消息，整批跳过
        mockedGetLastExtractedMsgId.mockResolvedValue('msg-003');
        mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result).toEqual({
            totalProcessed: 3,
            inserted: 0,
            updated: 0,
            skipped: 3,
        });
        // 游标命中后不查 DB、不调 LLM
        expect(mockedFind).not.toHaveBeenCalled();
        expect(mockedExtractFacts).not.toHaveBeenCalled();
        expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
        // 游标命中直接返回，不更新 Redis
        expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
    });

    it('P2b - 游标超过最后消息 ID 同样跳过整批', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue('msg-999');

        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result.skipped).toBe(3);
        expect(mockedExtractFacts).not.toHaveBeenCalled();
    });

    // ──────────────────── P3: DB 精确去重（二级防御）────────────────────

    it('P3 - DB 发现全部消息已处理，跳过 LLM 并更新游标', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue(null); // 游标无记录
        // DB 返回覆盖全部 3 条消息的文档
        mockFindLean([
            { sourceMessageIds: ['msg-001', 'msg-002'] },
            { sourceMessageIds: ['msg-003'] },
        ]);
        mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result).toEqual({
            totalProcessed: 3,
            inserted: 0,
            updated: 0,
            skipped: 3,
        });
        expect(mockedExtractFacts).not.toHaveBeenCalled();
        expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
        // DB 去重后更新游标
        expect(mockedSetLastExtractedMsgId).toHaveBeenCalledWith(
            fixtures.mockSessionId,
            'msg-003',
        );
    });

    // ──────────────────── P4: 部分去重 + 提取 ────────────────────

    it('P4 - 部分消息已处理，仅对新消息执行 LLM 提取', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue(null);
        // 仅 msg-001 在 DB 中已存在
        mockFindLean([{ sourceMessageIds: ['msg-001'] }]);
        mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

        // LLM 仅对 msg-002 + msg-003 提取
        mockedExtractFacts.mockResolvedValue([
            { content: '事实A', confidence: 0.9, sourceMessageIds: ['msg-002'] },
        ]);
        mockedGenerateEmbeddings.mockResolvedValue({
            embeddings: [[0.1, 0.2, 0.3]],
            totalTokens: 0,
        });
        mockedIngestMemoryFacts.mockResolvedValue({
            totalProcessed: 1,
            inserted: 1,
            updated: 0,
            skipped: 0,
        });

        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result.inserted).toBe(1);
        // extractFacts 仅收到 2 条新消息（msg-002, msg-003）
        expect(mockedExtractFacts).toHaveBeenCalledTimes(1);
        const extractCallArg = mockedExtractFacts.mock.calls[0]![0];
        expect(extractCallArg).toHaveLength(2);
        expect(extractCallArg.map((m: any) => m.msgId).sort()).toEqual([
            'msg-002',
            'msg-003',
        ]);
    });

    // ──────────────────── P5: 全链路成功 ────────────────────

    it('P5 - 全链路成功应走完 5 步并返回正确统计', async () => {
        setupHappyPath();
        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result).toEqual({
            totalProcessed: 2,
            inserted: 2,
            updated: 0,
            skipped: 0,
        });
        expect(mockedGetLastExtractedMsgId).toHaveBeenCalledTimes(1);
        expect(mockedFind).toHaveBeenCalledTimes(1);
        expect(mockedExtractFacts).toHaveBeenCalledTimes(1);
        expect(mockedGenerateEmbeddings).toHaveBeenCalledTimes(1);
        expect(mockedIngestMemoryFacts).toHaveBeenCalledTimes(1);
        expect(mockedSetLastExtractedMsgId).toHaveBeenCalledTimes(1);
    });

    // ──────────────────── P6: LLM 提取失败 ────────────────────

    it('P6 - LLM 提取失败应抛异常且不更新 Redis 标记', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue(null);
        mockFindLean([]);
        mockedExtractFacts.mockRejectedValue(new Error('LLM API timeout'));

        await expect(
            pipeline.run(fixtures.mockSessionId, fixtures.mockMessages),
        ).rejects.toThrow('LLM API timeout');
        expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
        expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
    });

    // ──────────────────── P7: 向量化失败 ────────────────────

    it('P7 - 向量化失败应抛异常且不更新 Redis 标记', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue(null);
        mockFindLean([]);
        mockedExtractFacts.mockResolvedValue([
            { content: '事实1', confidence: 0.9, sourceMessageIds: ['msg-001'] },
        ]);
        mockedGenerateEmbeddings.mockRejectedValue(
            new Error('Embedding API error'),
        );

        await expect(
            pipeline.run(fixtures.mockSessionId, fixtures.mockMessages),
        ).rejects.toThrow('Embedding API error');
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
        expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
    });

    // ──────────────────── P8: 入库失败 ────────────────────

    it('P8 - 入库失败应抛异常且不更新 Redis 标记', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue(null);
        mockFindLean([]);
        mockedExtractFacts.mockResolvedValue([
            { content: '事实1', confidence: 0.9, sourceMessageIds: ['msg-001'] },
        ]);
        mockedGenerateEmbeddings.mockResolvedValue({
            embeddings: [[0.1, 0.2, 0.3]],
            totalTokens: 0,
        });
        mockedIngestMemoryFacts.mockRejectedValue(
            new Error('MongoDB connection lost'),
        );

        await expect(
            pipeline.run(fixtures.mockSessionId, fixtures.mockMessages),
        ).rejects.toThrow('MongoDB connection lost');
        expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();
    });

    // ──────────────────── P9: 调用顺序验证 ────────────────────

    it('P9 - 各步骤严格按序调用：游标 → DB → LLM → 向量 → 入库 → 更新游标', async () => {
        setupHappyPath();
        await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);

        const callOrder = [
            mockedGetLastExtractedMsgId.mock.invocationCallOrder[0]!,
            mockedFind.mock.invocationCallOrder[0]!,
            mockedExtractFacts.mock.invocationCallOrder[0]!,
            mockedGenerateEmbeddings.mock.invocationCallOrder[0]!,
            mockedIngestMemoryFacts.mock.invocationCallOrder[0]!,
            mockedSetLastExtractedMsgId.mock.invocationCallOrder[0]!,
        ];
        for (let i = 0; i < callOrder.length - 1; i++) {
            expect(callOrder[i]).toBeLessThan(callOrder[i + 1]!);
        }
    });

    // ──────────────────── P10: DB 去重查询参数 ────────────────────

    it('P10 - DB 去重查询应使用 memoryKey + sourceMessageIds $in', async () => {
        setupHappyPath();
        await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
        expect(mockedFind).toHaveBeenCalledWith({
            memoryKey: fixtures.mockMemoryKey,
            sourceMessageIds: { $in: ['msg-001', 'msg-002', 'msg-003'] },
        });
    });

    // ──────────────────── P11: context 传参验证 ────────────────────

    it('P11 - 传给 ingestMemoryFacts 的 context 包含正确的 memoryKey', async () => {
        setupHappyPath();
        await pipeline.run(fixtures.mockSessionId, fixtures.mockMessages);
        const ingestCallArgs = mockedIngestMemoryFacts.mock.calls[0]!;
        const facts = ingestCallArgs[0];
        const context = ingestCallArgs[1];

        expect(context.memoryKey).toBe(fixtures.mockMemoryKey);
        // 每条 fact 的 embedding 来自向量化结果
        expect(facts[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
        expect(facts[1]!.embedding).toEqual([0.4, 0.5, 0.6]);
    });

    // ──────────────────── P12: 0 条事实提取后短路 ────────────────────

    it('P12 - LLM 提取 0 条有效事实应短路，跳过向量和入库但更新游标', async () => {
        mockedGetLastExtractedMsgId.mockResolvedValue(null);
        mockFindLean([]);
        mockedExtractFacts.mockResolvedValue([]);
        mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result).toEqual({
            totalProcessed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
        });
        expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
        // 即使无事实也更新游标，避免下次重复提取
        expect(mockedSetLastExtractedMsgId).toHaveBeenCalledWith(
            fixtures.mockSessionId,
            'msg-003',
        );
    });

    // ──────────────────── P13: 游标部分覆盖 + DB 部分去重 ────────────────────

    it('P13 - 游标部分覆盖 + DB 覆盖全部剩余，整批跳过', async () => {
        // 游标='msg-001'，DB 覆盖全部三条消息 → newSourceIds 为空 → 跳过
        mockedGetLastExtractedMsgId.mockResolvedValue('msg-001');
        mockFindLean([
            { sourceMessageIds: ['msg-001', 'msg-002'] },
            { sourceMessageIds: ['msg-003'] },
        ]);
        mockedSetLastExtractedMsgId.mockResolvedValue(undefined);

        const result = await pipeline.run(
            fixtures.mockSessionId,
            fixtures.mockMessages,
        );
        expect(result.skipped).toBe(3);
        expect(result.inserted).toBe(0);
        expect(mockedExtractFacts).not.toHaveBeenCalled();
        expect(mockedSetLastExtractedMsgId).toHaveBeenCalledWith(
            fixtures.mockSessionId,
            'msg-003',
        );
    });
});

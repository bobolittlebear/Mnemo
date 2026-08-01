/**
 * MemoryPipeline userId 解析单元测试（M2：构造注入 SessionIdentityResolver）
 *
 * 测试目标：验证 pipeline.run() 中 userId 的三条路径：
 *   ① resolver 成功返回 → 正常走全链路，userId 正确传递
 *   ② resolver 返回 null  → 早退，不入库，有 warn 日志
 *   ③ context.userId 显式传入 → 优先使用，resolver 不被调用（零 IO 短路）
 *   ④ adapter 不传 userId → pipeline 收到无 userId 的 context，走 resolver
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 外部依赖 ──

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

vi.mock('@/lib/logger', () => {
    const shared = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    return {
        createLogger: () => shared,
    };
});

vi.mock('@/utils/tool', () => ({
    generateSessionKey: (sessionId: string) => `mnemo:extraction:${sessionId}`,
    generateContentHash: (content: string) => `hash_${content}`,
}));

// ── 引入被测模块与 mock 引用 ──
import MemoryPipelineService from '@/services/memory/memoryPipeline.service';
import type { SessionIdentityResolver } from '@/services/memory/sessionIdentity.resolver';
import memoryExtractionService from '@/services/memory/memoryExtraction.service';
import { ingestMemoryFacts } from '@/services/memory/memoryIngestion.service';
import STM from '@/utils/shortTermMemory';
import { generateEmbeddings } from '@/lib/embedding';
import { MemoryFact } from '@/models/MemoryFact';
import { createLogger } from '@/lib/logger';
import * as fixtures from '../../../helpers/fixtures';

const mockedExtractFacts = vi.mocked(memoryExtractionService.extractFacts);
const mockedIngestMemoryFacts = vi.mocked(ingestMemoryFacts);
const mockedSetLastExtractedMsgId = vi.mocked(STM.setLastExtractedMsgId);
const mockedGetLastExtractedMsgId = vi.mocked(STM.getLastExtractedMsgId);
const mockedGenerateEmbeddings = vi.mocked(generateEmbeddings);
const mockedFind = vi.mocked(MemoryFact.find);

const logger = createLogger('ltm');
const mockWarn = vi.mocked(logger.warn);

// ── Fake Resolver 工厂 ──
function createFakeResolver(resolvedUserId: string | null): SessionIdentityResolver {
    return {
        resolve: vi.fn().mockResolvedValue(resolvedUserId),
        resolveBatch: vi.fn().mockResolvedValue(new Map()),
    };
}

/** Mock MemoryFact.find().select().lean() 链式调用 */
function mockFindLean(docs: Array<{ sourceMessageIds: string[] }>) {
    mockedFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(docs),
        }),
    } as any);
}

/** 设置全链路成功默认 Mock */
function setupHappyPath() {
    mockedGetLastExtractedMsgId.mockResolvedValue(null);
    mockFindLean([]);
    mockedExtractFacts.mockResolvedValue([
        { content: '事实1', confidence: 0.9, sourceMessageIds: ['msg-001'] },
        { content: '事实2', confidence: 0.85, sourceMessageIds: ['msg-003'] },
    ]);
    mockedGenerateEmbeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
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

const testSessionId = 'session-resolver-test';
const testMessages = fixtures.mockMessages;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('MemoryPipeline — userId 解析（M2）', () => {
    // ──────────────────── 用例①：resolver 成功返回 userId ────────────────────

    it('用例① - resolver 返回 userId 时，正常走全链路且 userId 正确传递到 extraction/入库', async () => {
        const resolver = createFakeResolver('u1');
        const pipeline = new MemoryPipelineService(resolver);
        setupHappyPath();

        const result = await pipeline.run({ sessionId: testSessionId }, testMessages);

        // 全链路成功
        expect(result.inserted).toBe(2);
        expect(mockedExtractFacts).toHaveBeenCalledTimes(1);
        expect(mockedIngestMemoryFacts).toHaveBeenCalledTimes(1);

        // resolver 被调用一次
        expect(resolver.resolve).toHaveBeenCalledWith(testSessionId);
        expect(resolver.resolve).toHaveBeenCalledTimes(1);

        // extraction 收到解析出的 userId
        const extractCallArg = mockedExtractFacts.mock.calls[0]![1]!;
        expect(extractCallArg.userId).toBe('u1');

        // 入库 context 包含解析出的 userId
        const ingestContext = mockedIngestMemoryFacts.mock.calls[0]![1];
        expect(ingestContext.userId).toBe('u1');
        expect(ingestContext.sessionId).toBe(testSessionId);
    });

    // ──────────────────── 用例②：resolver 返回 null → 早退 ────────────────────

    it('用例② - resolver 返回 null 时，run 早退、入库不被调用、有 warn 日志', async () => {
        const resolver = createFakeResolver(null);
        const pipeline = new MemoryPipelineService(resolver);

        const result = await pipeline.run({ sessionId: testSessionId }, testMessages);

        // 早退返回全 0
        expect(result).toEqual({
            totalProcessed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
        });

        // resolver 被调用
        expect(resolver.resolve).toHaveBeenCalledWith(testSessionId);

        // 任何后续步骤都不应被调用
        expect(mockedGetLastExtractedMsgId).not.toHaveBeenCalled();
        expect(mockedFind).not.toHaveBeenCalled();
        expect(mockedExtractFacts).not.toHaveBeenCalled();
        expect(mockedGenerateEmbeddings).not.toHaveBeenCalled();
        expect(mockedIngestMemoryFacts).not.toHaveBeenCalled();
        expect(mockedSetLastExtractedMsgId).not.toHaveBeenCalled();

        // warn 日志已输出
        expect(mockWarn).toHaveBeenCalledWith(
            '无法解析 userId，跳过提取',
            { sessionId: testSessionId },
        );
    });

    // ──────────────────── 用例③：context.userId 显式传入优先，resolver 不被调用 ────────────────────

    it('用例③ - context.userId 显式传入时优先使用，resolver 零 IO 短路不被调用', async () => {
        const resolver = createFakeResolver('u1'); // resolver 返回 'u1'
        const pipeline = new MemoryPipelineService(resolver);
        setupHappyPath();

        const explicitUserId = 'u2';
        const result = await pipeline.run(
            { sessionId: testSessionId, userId: explicitUserId },
            testMessages,
        );

        // 全链路成功
        expect(result.inserted).toBe(2);

        // resolver.resolve 不应被调用（?? 短路）
        expect(resolver.resolve).not.toHaveBeenCalled();

        // extraction 收到显式 userId
        const extractCallArg = mockedExtractFacts.mock.calls[0]![1]!;
        expect(extractCallArg.userId).toBe(explicitUserId);

        // 入库 context 包含显式 userId
        const ingestContext = mockedIngestMemoryFacts.mock.calls[0]![1];
        expect(ingestContext.userId).toBe(explicitUserId);
    });

    // ──────────────────── 用例④：adapter 不传 userId → pipeline 走 resolver ────────────────────

    it('用例④ - adapter 传入不含 userId 的 context，pipeline 走 resolver 解析', async () => {
        const resolver = createFakeResolver('resolved-from-redis');
        const pipeline = new MemoryPipelineService(resolver);
        setupHappyPath();

        // 模拟 adapter 行为：只传 sessionId，不传 userId
        const result = await pipeline.run({ sessionId: testSessionId }, testMessages);

        expect(result.inserted).toBe(2);

        // resolver 被调用
        expect(resolver.resolve).toHaveBeenCalledWith(testSessionId);
        expect(resolver.resolve).toHaveBeenCalledTimes(1);

        // 入库使用 resolver 返回的 userId
        const ingestContext = mockedIngestMemoryFacts.mock.calls[0]![1];
        expect(ingestContext.userId).toBe('resolved-from-redis');
        expect(ingestContext.sessionId).toBe(testSessionId);

        // extraction 也收到 resolver 返回的 userId
        const extractCallArg = mockedExtractFacts.mock.calls[0]![1]!;
        expect(extractCallArg.userId).toBe('resolved-from-redis');
    });
});

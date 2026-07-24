/**
 * Pipeline 集成测试
 *
 * 真实 MongoDB + Redis，Mock LLM + Embedding
 * 验证端到端的数据一致性、幂等性和 Redis 标记正确性
 *
 * 运行前提：
 *   1. MongoDB 已启动（本地 Docker mnemo-mongo 或 MONGODB_URI 可连）
 *   2. Redis 已启动（本地 Docker aiquicknote-redis 或 REDIS_URL 可连）
 *
 * 运行命令：pnpm test:integration
 *
 * 注意：集成测试会真实写数据到 mnemo_test 数据库，每个用例前后自动清理
 */

// ── Mock LLM + Embedding（真实服务太慢，集成测试关注 MongoDB/Redis 流程）──
import { vi } from 'vitest';

// Mock 响应数据（根据输入对话内容返回不同结果）
const mockCreateChat = vi.hoisted(() =>
    vi.fn(async (messages: any[]) => {
        const prompt = messages[messages.length - 1]?.content || '';

        // 短对话 / 废话 → 无有效事实
        if (prompt.includes('嗯') && prompt.includes('好的')) {
            return { content: '{"facts": []}' };
        }

        // 张三相关对话
        if (prompt.includes('张三')) {
            return {
                content: JSON.stringify({
                    facts: [
                        {
                            action: 'ADD',
                            content: '用户名叫张三，在杭州做前端开发',
                            old_memory: null,
                            confidence: 0.95,
                            category: 'personal_info',
                            source_time: '2026-07',
                        },
                        {
                            action: 'ADD',
                            content: '用户有3年前端开发经验',
                            old_memory: null,
                            confidence: 0.9,
                            category: 'skill',
                            source_time: '2026-07',
                        },
                        {
                            action: 'ADD',
                            content: '用户技术栈主要是 React 和 TypeScript',
                            old_memory: null,
                            confidence: 0.9,
                            category: 'skill',
                            source_time: '2026-07',
                        },
                    ],
                }),
            };
        }

        // 李四相关对话
        if (prompt.includes('李四')) {
            return {
                content: JSON.stringify({
                    facts: [
                        {
                            action: 'ADD',
                            content: '用户名叫李四',
                            old_memory: null,
                            confidence: 0.9,
                            category: 'personal_info',
                            source_time: '2026-07',
                        },
                        {
                            action: 'ADD',
                            content: '用户在杭州工作',
                            old_memory: null,
                            confidence: 0.85,
                            category: 'personal_info',
                            source_time: '2026-07',
                        },
                    ],
                }),
            };
        }

        // 默认返回空事实
        return { content: '{"facts": []}' };
    }),
);

const mockGenerateEmbeddings = vi.hoisted(() =>
    vi.fn(async (input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        // 固定 1536 维向量（匹配 EMBEDDING_CONFIG.DEFAULT_EMBEDDING_DIMENSIONS）
        const embeddings = texts.map((_, i) => {
            const vec = new Array(1536).fill(0);
            vec[0] = 0.1 * (i + 1);
            vec[1] = 0.2 * (i + 1);
            vec[2] = 0.3 * (i + 1);
            return vec;
        });
        return { totalTokens: 100, embeddings };
    }),
);

vi.mock('@/services/ai.service', () => ({
    createChat: mockCreateChat,
}));

vi.mock('@/lib/embedding', () => ({
    generateEmbeddings: mockGenerateEmbeddings,
    generateEmbedding: vi.fn(async (text: string) => {
        const vec = new Array(1536).fill(0);
        vec[0] = 0.15;
        return { totalTokens: 50, embeddings: [vec] };
    }),
    decodeEmbedding: vi.fn((e: any) => e),
    formatVectors: vi.fn((v: any) => v),
    countPromptTokens: vi.fn(() => 0),
}));

// ── 正式导入（Mock 已注入）──
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MemoryFact } from '@/models/MemoryFact';
import STM from '@/utils/shortTermMemory';
import redisClient from '@/lib/redis';
import { generateSessionKey } from '@/utils/tool';
import memoryPipeline from '@/services/memory/memoryPipeline.service';

// ── 测试数据库配置 ──
const TEST_MONGO_URI =
    process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/mnemo_test';

// ── 测试数据 ──
const testSessionId = 'integration-test-session';
const testTimestamp = Date.now();
const testMessages = [
    {
        id: 'int-msg-001',
        msgId: 'int-msg-001',
        role: 'user' as const,
        content:
            '我叫张三，目前在杭州做前端开发，有3年经验，主要用 React 和 TypeScript。',
        timestamp: testTimestamp,
    },
    {
        id: 'int-msg-002',
        msgId: 'int-msg-002',
        role: 'assistant' as const,
        content:
            '了解了！你在杭州做前端，3年经验，技术栈是 React + TypeScript。',
        timestamp: testTimestamp,
    },
    {
        id: 'int-msg-003',
        msgId: 'int-msg-003',
        role: 'user' as const,
        content: '帮我总结一下 React hooks 的高频面试题吧。',
        timestamp: testTimestamp,
    },
];

// ── 所有测试用到的 session ID（用于清理）──
const allTestSessionIds = [
    testSessionId,
    'dup-session-a',
    'dup-session-b',
    'nonsense-session',
];

beforeAll(async () => {
    await mongoose.connect(TEST_MONGO_URI);
});

afterAll(async () => {
    await MemoryFact.deleteMany({});
    for (const sid of allTestSessionIds) {
        await STM.clearSession(sid);
        await redisClient.del(generateSessionKey(sid));
    }
    await mongoose.disconnect();
});

beforeEach(async () => {
    // 每个用例前清理 MongoDB + Redis + 重置 Mock 调用记录
    await MemoryFact.deleteMany({});
    for (const sid of allTestSessionIds) {
        await STM.clearSession(sid);
        await redisClient.del(generateSessionKey(sid));
    }
    mockCreateChat.mockClear();
    mockGenerateEmbeddings.mockClear();
});

describe('Pipeline 集成测试', () => {
    // ═══════════════════════════════════════
    // INT1: 端到端提取入库 + Redis 标记
    // ═══════════════════════════════════════
    it('INT1 - 端到端：对话消息 → 提取 → 向量化 → 入库落盘 + Redis 标记', async () => {
        const result = await memoryPipeline.run(testSessionId, testMessages);

        // 验证返回结果
        expect(result.totalProcessed).toBe(3); // Mock 返回 3 条事实
        expect(result.inserted).toBe(3);

        // 验证 LLM 和 Embedding 都被调用了，且参数正确
        expect(mockCreateChat).toHaveBeenCalledOnce();
        const llmCallArgs = mockCreateChat.mock.calls[0]!;
        expect(llmCallArgs[0][0].role).toBe('system');
        expect(llmCallArgs[0][0].content).toContain('张三');
        expect(llmCallArgs[0][0].content).toContain('React');

        expect(mockGenerateEmbeddings).toHaveBeenCalledOnce();
        const embeddingCallArgs = mockGenerateEmbeddings.mock.calls[0]!;
        expect(embeddingCallArgs[0]).toEqual(
            expect.arrayContaining([
                '用户名叫张三，在杭州做前端开发',
                '用户有3年前端开发经验',
                '用户技术栈主要是 React 和 TypeScript',
            ]),
        );

        // 验证数据真的写进了 MongoDB
        const factsInDb = await MemoryFact.find({
            memoryKey: generateSessionKey(testSessionId),
        }).lean();

        expect(factsInDb.length).toBe(3);

        // 验证每条 fact 结构完整（强断言，精确值）
        const expectedContents = [
            '用户名叫张三，在杭州做前端开发',
            '用户有3年前端开发经验',
            '用户技术栈主要是 React 和 TypeScript',
        ];
        const actualContents = factsInDb.map((f) => f.content).sort();
        expect(actualContents).toEqual([...expectedContents].sort());

        for (const fact of factsInDb) {
            expect(typeof fact.content).toBe('string');
            expect(fact.content.length).toBeGreaterThanOrEqual(5);
            expect(Array.isArray(fact.embedding)).toBe(true);
            expect(fact.embedding!.length).toBe(1536);
            expect(fact.confidence).toBeGreaterThanOrEqual(0.6);
            expect(fact.contentHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
            // expect(fact.sourceMessageIds.length).toBeGreaterThan(0);
        }

        // 验证 Redis 标记已更新为最后一条消息 ID
        const lastId = await STM.getLastExtractedMsgId(testSessionId);
        expect(lastId).toBe('int-msg-003');
    });

    // ═══════════════════════════════════════
    // INT2: 重复执行幂等 + Redis 标记
    // ═══════════════════════════════════════
    it('INT2 - 同一消息列表重复执行，第二次应跳过，标记仍正确', async () => {
        // 第一次执行
        const result1 = await memoryPipeline.run(testSessionId, testMessages);
        expect(result1.inserted).toBeGreaterThan(0);

        // 第一次执行后 Redis 标记应为最后一条消息 ID
        const lastId1 = await STM.getLastExtractedMsgId(testSessionId);
        expect(lastId1).toBe('int-msg-003');

        // 统计 DB 中的 fact 数量
        const countAfterFirst = await MemoryFact.countDocuments({
            memoryKey: generateSessionKey(testSessionId),
        });

        // 第二次执行相同消息 — 幂等检查应跳过
        const result2 = await memoryPipeline.run(testSessionId, testMessages);

        // 应该跳过，返回全 0
        expect(result2.totalProcessed).toBe(testMessages.length);
        expect(result2.skipped).toBe(testMessages.length);
        expect(result2.inserted).toBe(0);

        // DB 中 fact 数量不应增加
        const countAfterSecond = await MemoryFact.countDocuments({
            memoryKey: generateSessionKey(testSessionId),
        });
        expect(countAfterSecond).toBe(countAfterFirst);

        // 第二次执行后标记仍然正确
        const lastId2 = await STM.getLastExtractedMsgId(testSessionId);
        expect(lastId2).toBe('int-msg-003');

        // LLM 只被调用一次（第二次被幂等检查拦截）
        expect(mockCreateChat).toHaveBeenCalledOnce();
    });

    // ═══════════════════════════════════════
    // INT3: contentHash 去重
    // ═══════════════════════════════════════
    it('INT3 - 同一 memoryKey 内 contentHash 去重', async () => {
        // 同一 session 连续两次提取相同内容
        // 第二次应该 upsert 更新而非新增
        const messagesA = [
            {
                id: 'dup-msg-a1',
                msgId: 'dup-msg-a1',
                role: 'user' as const,
                content: '我叫李四，在杭州工作。',
                timestamp: testTimestamp,
            },
        ];

        await memoryPipeline.run('dup-session-a', messagesA);

        // 同一 memoryKey 内没有 contentHash 重复
        const facts = await MemoryFact.find({
            memoryKey: generateSessionKey('dup-session-a'),
        }).lean();

        const hashes = facts.map((f) => f.contentHash);
        const uniqueHashes = [...new Set(hashes)];
        expect(hashes.length).toBe(uniqueHashes.length);

        // 验证 Redis 标记正确
        const lastIdA = await STM.getLastExtractedMsgId('dup-session-a');
        expect(lastIdA).toBe('dup-msg-a1');
    });

    // ═══════════════════════════════════════
    // INT4: 空对话安全性 + 标记仍然更新
    // ═══════════════════════════════════════
    it('INT4 - 无有效事实的对话应安全处理，标记仍然正确更新', async () => {
        const nonsenseMessages = [
            {
                id: 'nonsense-001',
                msgId: 'nonsense-001',
                role: 'user' as const,
                content: '嗯',
                timestamp: testTimestamp,
            },
            {
                id: 'nonsense-002',
                msgId: 'nonsense-002',
                role: 'assistant' as const,
                content: '好的',
                timestamp: testTimestamp,
            },
        ];

        const result = await memoryPipeline.run(
            'nonsense-session',
            nonsenseMessages,
        );

        // Mock 返回空事实
        expect(result.totalProcessed).toBe(0);

        // DB 中不应有脏数据
        const facts = await MemoryFact.find({
            memoryKey: generateSessionKey('nonsense-session'),
        }).lean();
        expect(facts.length).toBe(0);

        // 即使没有提取出事实，Redis 标记也应更新（避免下次重复调 LLM）
        const lastId = await STM.getLastExtractedMsgId('nonsense-session');
        expect(lastId).toBe('nonsense-002');

        // LLM 被调用了，且收到的是废话对话内容
        expect(mockCreateChat).toHaveBeenCalledOnce();
        const llmArgs = mockCreateChat.mock.calls[0]!;
        expect(llmArgs[0][0].content).toContain('嗯');
        expect(llmArgs[0][0].content).toContain('好的');
    });

    // ═══════════════════════════════════════
    // INT5: 幂等检查 — Redis 标记 + DB 数据被清除后重新提取
    // ═══════════════════════════════════════
    it('INT5 - Redis 标记被清除后，相同消息应重新提取', async () => {
        // 第一次执行
        const result1 = await memoryPipeline.run(testSessionId, testMessages);
        expect(result1.inserted).toBeGreaterThan(0);

        // 清除 MongoDB 中的 facts（模拟数据丢失）
        await MemoryFact.deleteMany({
            memoryKey: generateSessionKey(testSessionId),
        });

        // 清除 Redis 标记（模拟标记过期或丢失）
        await redisClient.del(generateSessionKey(testSessionId));

        // 第二次执行 — 幂等检查找不到已提取记录，应重新走全链路
        const result2 = await memoryPipeline.run(testSessionId, testMessages);
        expect(result2.inserted).toBeGreaterThan(0);

        // 标记再次更新
        const lastId = await STM.getLastExtractedMsgId(testSessionId);
        expect(lastId).toBe('int-msg-003');

        // LLM 被调用了两次（第一次 + 清除后重新提取）
        expect(mockCreateChat).toHaveBeenCalledTimes(2);
    });
});

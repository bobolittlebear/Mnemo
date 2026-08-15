/**
 * Memory Version 集成测试
 *
 * 真实 MongoDB，Mock LLM + Embedding
 * 验证记忆版本管理链路：ADD / UPDATE / DELETE / 软删除过滤 / limit 50 / category other
 *
 * 运行前提：
 *   1. MongoDB 已启动（MONGODB_URI 可连）
 *   2. Redis 已启动（REDIS_URL 可连）
 *
 * 运行命令：pnpm vitest run tests/integration/memory/memoryVersion.integration.test.ts
 */

// ── Hoisted Mock: LLM + Embedding ──
import { vi } from 'vitest';

/** 捕获最近一次 LLM 调用收到的 prompt，供 I5 断言 */
let capturedPrompt = '';
/** I2 UPDATE 场景下指向旧记忆的 _id（字符串，在 beforeAll/beforeEach 中设置） */
let updateTargetId = '';
/** I3 DELETE 场景下指向旧记忆的 _id（字符串，在 beforeAll/beforeEach 中设置） */
let deleteTargetId = '';
/** 控制 mock 返回哪个场景的数据 */
type TestScenario = 'I1' | 'I2' | 'I3' | 'I5' | 'I6' | 'default';
let currentScenario: TestScenario = 'default';

const mockCreateChat = vi.hoisted(() =>
    vi.fn(async (messages: any[]) => {
        capturedPrompt = messages[0]?.content ?? '';

        switch (currentScenario) {
            case 'I1':
                return {
                    content: JSON.stringify({
                        facts: [
                            {
                                action: 'ADD',
                                content: '用户喜欢喝咖啡',
                                confidence: 0.9,
                                category: 'preference',
                            },
                        ],
                    }),
                };
            case 'I2':
                return {
                    content: JSON.stringify({
                        facts: [
                            {
                                action: 'UPDATE',
                                content: '用户现在喜欢喝茶（已更新）',
                                old_memory: updateTargetId,
                                confidence: 0.9,
                                category: 'preference',
                            },
                        ],
                    }),
                };
            case 'I3':
                return {
                    content: JSON.stringify({
                        facts: [
                            {
                                action: 'DELETE',
                                content: '用户已不再养猫',
                                old_memory: deleteTargetId,
                                confidence: 0.9,
                                category: 'preference',
                            },
                        ],
                    }),
                };
            case 'I5':
                return {
                    content: JSON.stringify({
                        facts: [
                            {
                                action: 'ADD',
                                content: 'I5 新增事实内容',
                                confidence: 0.9,
                                category: 'personal_info',
                            },
                        ],
                    }),
                };
            case 'I6':
                return {
                    content: JSON.stringify({
                        facts: [
                            {
                                action: 'ADD',
                                content: 'I6 其他类别的事实内容',
                                confidence: 0.9,
                                category: 'other',
                            },
                        ],
                    }),
                };
            default:
                return { content: '{"facts": []}' };
        }
    }),
);

const mockGenerateEmbeddings = vi.hoisted(() =>
    vi.fn(async (input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
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
}));

// ── 导入（Mock 已注入）──
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MemoryFact } from '@/models/MemoryFact';
import MemoryPipelineService from '@/services/memory/memoryPipeline.service';
import type { SessionIdentityResolver } from '@/services/memory/sessionIdentity.resolver';
import { generateContentHash } from '@/utils/tool';
import STM from '@/utils/shortTermMemory';
import redisClient from '@/lib/redis';

// ── 配置 ──
const TEST_MONGO_URI =
    process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/mnemo_test';
const TEST_USER_ID = 'integration-version-test-user';
const TEST_SESSION_ID = 'integration-version-test-session';

function sessionUserKey() {
    return `quick_note:session:${TEST_SESSION_ID}`;
}

// ── Fake Resolver（显式传 userId，跳过 resolver）──
const fakeResolver: SessionIdentityResolver = {
    resolve: vi.fn().mockResolvedValue(null),
};
const pipeline = new MemoryPipelineService(fakeResolver);

// ── Hooks ──
beforeAll(async () => {
    await mongoose.connect(TEST_MONGO_URI);
});

afterAll(async () => {
    await MemoryFact.deleteMany({ userId: TEST_USER_ID });
    await STM.clearSession(TEST_SESSION_ID);
    await redisClient.del(sessionUserKey());
    await mongoose.disconnect();
});

beforeEach(async () => {
    await MemoryFact.deleteMany({ userId: TEST_USER_ID });
    await STM.clearSession(TEST_SESSION_ID);
    await redisClient.del(sessionUserKey());
    mockCreateChat.mockClear();
    mockGenerateEmbeddings.mockClear();
    capturedPrompt = '';
    updateTargetId = '';
    deleteTargetId = '';
    currentScenario = 'default';
});

// ── 辅助：创建测试用 MemoryFact ──
async function createTestFact(overrides: Record<string, unknown> = {}) {
    const defaults = {
        userId: TEST_USER_ID,
        content: '默认测试内容',
        sourceMessageIds: ['test-msg-001'],
        confidence: 0.9,
        category: 'personal_info',
        contentHash: generateContentHash(overrides.content as string ?? '默认测试内容'),
    };
    return MemoryFact.create({ ...defaults, ...overrides });
}

// ═══════════════════════════════════════
// I1-I6: 记忆版本管理集成测试
// ═══════════════════════════════════════
describe('Memory Version 集成测试', () => {
    // ──────────────────── I1: ADD ────────────────────
    it('I1 - ADD：对话引入新事实，pipeline.run 后 DB 存在新记录', async () => {
        currentScenario = 'I1';
        const messages = [
            {
                id: 'i1-msg-001',
                msgId: 'i1-msg-001',
                role: 'user' as const,
                content: '我喜欢喝咖啡，每天早上都要来一杯。',
                timestamp: Date.now(),
            },
        ];

        const result = await pipeline.run(
            { sessionId: TEST_SESSION_ID, userId: TEST_USER_ID },
            messages,
        );

        expect(result.inserted).toBe(1);
        expect(mockCreateChat).toHaveBeenCalledTimes(1);
        expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);

        const fact = await MemoryFact.findOne({ userId: TEST_USER_ID });
        expect(fact).not.toBeNull();
        expect(fact!.content).toBe('用户喜欢喝咖啡');
        expect(fact!.category).toBe('preference');
        expect(fact!.confidence).toBe(0.9);
    });

    // ──────────────────── I2: UPDATE ────────────────────
    it('I2 - UPDATE：旧记忆的 content/embedding/contentHash/searchText 在更新后已改变', async () => {
        // 1. 插入旧记忆
        const oldContent = '用户喜欢喝咖啡';
        const oldFact = await createTestFact({
            content: oldContent,
            category: 'preference',
            contentHash: generateContentHash(oldContent),
            embedding: new Array(1536).fill(0.01),
            searchText: '用户 喜欢 喝 咖啡',
        });
        updateTargetId = oldFact._id.toString();

        // 2. 触发更新
        currentScenario = 'I2';
        const messages = [
            {
                id: 'i2-msg-001',
                msgId: 'i2-msg-001',
                role: 'user' as const,
                content: '我最近改喝茶了，不喝咖啡了。',
                timestamp: Date.now(),
            },
        ];

        await pipeline.run(
            { sessionId: TEST_SESSION_ID, userId: TEST_USER_ID },
            messages,
        );

        // 3. 断言旧记录的字段已更新
        const updated = await MemoryFact.findById(oldFact._id);
        expect(updated).not.toBeNull();

        const newContent = '用户现在喜欢喝茶（已更新）';
        expect(updated!.content).toBe(newContent);
        expect(updated!.contentHash).toBe(generateContentHash(newContent));
        // searchText 不应等于旧值
        expect(updated!.searchText).not.toBe('用户 喜欢 喝 咖啡');
        // embedding 应已被覆盖（不等于旧的全 0.01 向量）
        expect(updated!.embedding![0]).not.toBe(0.01);
        // category / confidence 应更新
        expect(updated!.category).toBe('preference');
        expect(updated!.confidence).toBe(0.9);
    });

    // ──────────────────── I3: DELETE ────────────────────
    it('I3 - DELETE：对话触发删除后，旧记录的 deletedAt 非空', async () => {
        // 1. 插入旧记忆
        const oldFact = await createTestFact({
            content: '用户养了一只猫',
            category: 'personal_info',
            contentHash: generateContentHash('用户养了一只猫'),
        });
        deleteTargetId = oldFact._id.toString();

        // 2. 触发删除
        currentScenario = 'I3';
        const messages = [
            {
                id: 'i3-msg-001',
                msgId: 'i3-msg-001',
                role: 'user' as const,
                content: '我不养猫了，已经送人了。',
                timestamp: Date.now(),
            },
        ];

        await pipeline.run(
            { sessionId: TEST_SESSION_ID, userId: TEST_USER_ID },
            messages,
        );

        // 3. 断言 deletedAt 非空
        const deleted = await MemoryFact.findById(oldFact._id);
        expect(deleted).not.toBeNull();
        expect(deleted!.deletedAt).toBeInstanceOf(Date);
    });

    // ──────────────────── I4: 软删除过滤 ────────────────────
    it('I4 - 软删除过滤：deletedAt 非空的记录不会被 find 查询返回', async () => {
        // 插入一条软删除记录
        await createTestFact({
            content: '已删除的记忆内容',
            category: 'personal_info',
            contentHash: generateContentHash('已删除的记忆内容'),
            deletedAt: new Date(),
        });

        // 插入一条正常记录
        await createTestFact({
            content: '正常记忆内容',
            category: 'personal_info',
            contentHash: generateContentHash('正常记忆内容'),
        });

        // 查询：应只返回正常记录
        const results = await MemoryFact.find({
            userId: TEST_USER_ID,
            deletedAt: { $exists: false },
        });

        expect(results).toHaveLength(1);
        expect(results[0]!.content).toBe('正常记忆内容');
    });

    // ──────────────────── I5: limit 50 ────────────────────
    it('I5 - limit 50：插入 60 条记忆后，传入 LLM 的已有记忆数 ≤ 50', async () => {
        // 1. 批量插入 60 条记忆
        const bulkFacts = Array.from({ length: 60 }, (_, i) => ({
            userId: TEST_USER_ID,
            content: `批量记忆内容 ${String(i + 1).padStart(3, '0')}`,
            sourceMessageIds: [`src-${i + 1}`],
            confidence: 0.9,
            category: 'personal_info' as const,
            contentHash: generateContentHash(
                `批量记忆内容 ${String(i + 1).padStart(3, '0')}`,
            ),
        }));
        await MemoryFact.insertMany(bulkFacts);

        // 2. 运行 pipeline
        currentScenario = 'I5';
        const messages = [
            {
                id: 'i5-msg-001',
                msgId: 'i5-msg-001',
                role: 'user' as const,
                content: '这是一条新对话，用于触发记忆提取。',
                timestamp: Date.now(),
            },
        ];

        await pipeline.run(
            { sessionId: TEST_SESSION_ID, userId: TEST_USER_ID },
            messages,
        );

        // 3. 解析 prompt 中 EXISTING_MEMORIES 段落的记忆行数
        //    格式：_id|content，每条一行
        const afterMemories =
            capturedPrompt.split(
                '已有记忆（用于去重/更新/矛盾检测）:',
            )[1];
        const beforeClosing = afterMemories?.split(
            '（上述记忆内容均不包含推断属性）',
        )[0] ?? '';
        const memLines = beforeClosing
            .trim()
            .split('\n')
            .filter((line) => line.includes('|'));

        expect(memLines.length).toBeLessThanOrEqual(50);
        // 上限 50 意味着不应包含全部 60 条
        expect(memLines.length).toBeLessThan(60);
    });

    // ──────────────────── I6: category other ────────────────────
    it('I6 - category other：LLM 返回 category "other"，入库不报错', async () => {
        currentScenario = 'I6';
        const messages = [
            {
                id: 'i6-msg-001',
                msgId: 'i6-msg-001',
                role: 'user' as const,
                content: '今天写了好多 bug，哈哈哈。',
                timestamp: Date.now(),
            },
        ];

        const result = await pipeline.run(
            { sessionId: TEST_SESSION_ID, userId: TEST_USER_ID },
            messages,
        );

        expect(result.inserted).toBe(1);
        const fact = await MemoryFact.findOne({ userId: TEST_USER_ID });
        expect(fact).not.toBeNull();
        expect(fact!.category).toBe('other');
        expect(fact!.content).toBe('I6 其他类别的事实内容');
    });
});

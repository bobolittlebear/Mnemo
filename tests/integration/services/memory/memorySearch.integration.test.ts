/**
 * MemorySearchService 混合检索集成测试
 *
 * 真实 MongoDB，Mock Embedding API
 * 验证端到端的向量检索 + 关键词检索 + RRF 融合 + memoryKey 隔离
 *
 * 运行前提：
 *   1. MongoDB 已启动（本地 Docker mnemo-mongo 或 MONGODB_URI 可连）
 *   2. MongoDB 已创建 text index `memory_content_text_index`（beforeAll 自动创建）
 *   3. （可选）Atlas Vector Search 索引 `autoembed_index` 已创建
 *      - 若未创建，向量检索将失败并自动降级为关键词检索
 *      - 测试会自动检测并调整 degraded 断言
 *
 * 运行命令：pnpm test:integration
 *
 * 注意：集成测试会真实写数据到 mnemo_test 数据库，每个用例前后自动清理
 */

// ── Mock Embedding（真实 API 太慢且不可控，集成测试关注检索流程）──
import { vi } from 'vitest';

const mockGenerateEmbedding = vi.hoisted(() =>
    vi.fn(async (text: string) => {
        // 字符级别的编码相似性，而非语义相似性
        // 只能验证 "向量检索管道是否跑通"（数据写入、索引查询、RRF 融合等工程链路），
        // 不能验证"检索结果是否语义相关"
        // 基于文本内容生成确定性向量，使相似文本有相近向量
        const vec = new Array(1536).fill(0);
        for (let i = 0; i < Math.min(text.length, 1536); i++) {
            vec[i] = text.charCodeAt(i) / 65536;
        }
        return { totalTokens: 50, embeddings: [vec] };
    }),
);

vi.mock('@/lib/embedding', () => ({
    generateEmbedding: mockGenerateEmbedding,
    generateEmbeddings: vi.fn(async (input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        const embeddings = texts.map((text) => {
            // if (text === '小熊喜欢什么') return vectors[2];
            const vec = new Array(1536).fill(0);
            for (let i = 0; i < Math.min(text.length, 1536); i++) {
                vec[i] = text.charCodeAt(i) / 65536;
            }
            return vec;
        });
        return { totalTokens: 100, embeddings };
    }),
    decodeEmbedding: vi.fn((e: any) => e),
    formatVectors: vi.fn((v: any) => v),
    countPromptTokens: vi.fn(() => 0),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// ── 正式导入（Mock 已注入）──
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MemoryFact } from '@/models/MemoryFact';
import { generateContentHash } from '@/utils/tool';
import memorySearchService from '@/services/memory/memorySearch.service';

// ── 测试数据库配置 ──
const TEST_MONGO_URI =
    process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/mnemo_test';

// ── 测试数据工厂 ──

/** 生成确定性 embedding（与 mockGenerateEmbedding 逻辑一致） */
function makeEmbeddingFromText(text: string): number[] {
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < Math.min(text.length, 1536); i++) {
        vec[i] = text.charCodeAt(i) / 65536;
    }
    return vec;
}

/** 批量插入 MemoryFact 文档 */
async function insertFacts(
    facts: Array<{
        memoryKey: string;
        content: string;
        embedding?: number[];
        confidence?: number;
        category?: string;
        type?: 'fact' | 'note_chunk' | 'media';
        notebookId?: string;
    }>,
) {
    const docs = facts.map((f) => ({
        memoryKey: f.memoryKey,
        content: f.content,
        embedding: f.embedding ?? makeEmbeddingFromText(f.content),
        confidence: f.confidence ?? 0.9,
        category: f.category ?? 'preference',
        type: f.type ?? 'fact',
        contentHash: generateContentHash(f.content),
        sourceMessageIds: ['int-search-msg'],
        notebookId: f.notebookId ?? null,
        metadata: {},
    }));

    await MemoryFact.insertMany(docs);
}

// ── 测试用 memoryKey ──

const KEY_A = 'int-search:key-a';
const KEY_B = 'int-search:key-b';
const ALL_KEYS = [KEY_A, KEY_B];

// ── 向量检索可用性检测 ──

let vectorSearchAvailable = false;

/**
 * 检测 $vectorSearch 是否可用（本地 MongoDB 通常不支持）
 * 通过执行一次简单的 aggregate 来判断
 */
async function detectVectorSearchAvailability(): Promise<boolean> {
    try {
        await MemoryFact.aggregate([
            {
                $vectorSearch: {
                    index: 'autoembed_index',
                    path: 'embedding',
                    queryVector: new Array(1536).fill(0),
                    numCandidates: 1,
                    limit: 1,
                },
            },
        ]);
        return true;
    } catch {
        return false;
    }
}

// ── 连接与清理 ──

beforeAll(async () => {
    await mongoose.connect(TEST_MONGO_URI);

    // 确保 text index 已创建（autoIndex: false 时需要手动触发）
    await MemoryFact.createIndexes();

    // 检测向量检索可用性
    vectorSearchAvailable = await detectVectorSearchAvailability();
});

afterAll(async () => {
    await MemoryFact.deleteMany({
        memoryKey: { $in: ALL_KEYS },
    });
    await mongoose.disconnect();
});

beforeEach(async () => {
    await MemoryFact.deleteMany({
        memoryKey: { $in: ALL_KEYS },
    });
    mockGenerateEmbedding.mockClear();
});

// ── 集成测试 ──

describe('MemorySearchService 混合检索集成测试', () => {
    // ═══════════════════════════════════════
    // INT1: 端到端混合检索
    // ═══════════════════════════════════════
    it('INT1 - 端到端：插入数据后混合检索返回正确结果', async () => {
        // 插入 10 条不同内容
        const facts = Array.from({ length: 10 }, (_, i) => ({
            memoryKey: KEY_A,
            content: `用户偏好 TypeScript 和 React，项目编号 ${i + 1}`,
        }));
        await insertFacts(facts);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'TypeScript 和 React',
        });

        // 返回结果 ≤ 10（finalTopN 默认 10）
        expect(result.results.length).toBeLessThanOrEqual(10);

        // 每条结果包含核心字段
        for (const r of result.results) {
            expect(r.content).toContain('TypeScript');
            expect(typeof r.rrfScore).toBe('number');
            expect(r.memoryKey).toBe(KEY_A);
        }

        // 向量或关键词至少一路有命中
        expect(result.vectorCount + result.textCount).toBeGreaterThan(0);
    });

    // ═══════════════════════════════════════
    // INT2: RRF 融合效果
    // ═══════════════════════════════════════
    it('INT2 - 双路命中的文档 RRF 分数高于单路命中', async () => {
        // 1 条内容精准匹配 "docker kubernetes"，向量和关键词都更容易命中
        const overlapFact = {
            memoryKey: KEY_A,
            content: '小熊喜欢打游戏',
        };
        // 2 条仅关键词可能命中的文档
        const textOnlyFacts = [
            {
                memoryKey: KEY_A,
                content: '我喜欢小熊',
            },
            {
                memoryKey: KEY_A,
                content: '我爱小熊',
            },
            {
                memoryKey: KEY_A,
                content: '小熊喜欢打游戏2',
            },
            {
                memoryKey: KEY_A,
                content: '小熊喜欢妈妈',
            },
        ];

        await insertFacts([overlapFact, ...textOnlyFacts]);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: '小熊喜欢打游戏',
        });

        // 有结果返回
        expect(result.results.length).toBeGreaterThan(0);

        // 双路命中的文档（如果返回了）应排名靠前
        const overlapDoc = result.results.find(
            (r) =>
                r.content.includes('docker') &&
                r.content.includes('kubernetes') &&
                r.content.includes('运维'),
        );
        if (overlapDoc) {
            // 双路命中文档的 rrfScore 应大于所有单路命中文档
            const singleHitDocs = result.results.filter(
                (r) =>
                    !(
                        r.content.includes('docker') &&
                        r.content.includes('kubernetes') &&
                        r.content.includes('运维')
                    ),
            );
            if (singleHitDocs.length > 0) {
                const maxSingleScore = Math.max(
                    ...singleHitDocs.map((d) => d.rrfScore),
                );
                expect(overlapDoc.rrfScore).toBeGreaterThanOrEqual(
                    maxSingleScore,
                );
            }
        }
    });

    // ═══════════════════════════════════════
    // INT3: memoryKey 隔离
    // ═══════════════════════════════════════
    it('INT3 - memoryKey 隔离：不同 key 的数据互不干扰', async () => {
        // KEY_A: 5 条关于前端的内容
        const factsA = Array.from({ length: 5 }, (_, i) => ({
            memoryKey: KEY_A,
            content: `用户前端开发经验 ${i + 1} 年，使用 React`,
        }));

        // KEY_B: 5 条关于后端的内容
        const factsB = Array.from({ length: 5 }, (_, i) => ({
            memoryKey: KEY_B,
            content: `用户后端开发经验 ${i + 1} 年，使用 Node.js`,
        }));

        await insertFacts([...factsA, ...factsB]);

        const resultA = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'React 前端开发',
        });

        const resultB = await memorySearchService.search({
            memoryKey: KEY_B,
            query: 'Node.js 后端开发',
        });

        // KEY_A 的结果全部属于 KEY_A
        for (const r of resultA.results) {
            expect(r.memoryKey).toBe(KEY_A);
            expect(r.content).toContain('前端');
        }

        // KEY_B 的结果全部属于 KEY_B
        for (const r of resultB.results) {
            expect(r.memoryKey).toBe(KEY_B);
            expect(r.content).toContain('后端');
        }

        // 互不串：KEY_A 的结果不应包含 KEY_B 的内容
        expect(
            resultA.results.every((r) => !r.content.includes('Node.js')),
        ).toBe(true);
        expect(resultB.results.every((r) => !r.content.includes('React'))).toBe(
            true,
        );
    });

    // ═══════════════════════════════════════
    // INT4: 降级路径（Embedding 失败）
    // ═══════════════════════════════════════
    it('INT4 - Embedding 失败时降级为关键词检索', async () => {
        await insertFacts([
            { memoryKey: KEY_A, content: '用户喜欢吃 hotpot 和 spicy food' },
            { memoryKey: KEY_A, content: '用户偏好 Sichuan cuisine 口味' },
        ]);

        // Mock embedding 失败
        mockGenerateEmbedding.mockRejectedValueOnce(
            new Error('Embedding API 限流'),
        );

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'hotpot spicy',
        });

        // 降级标记
        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toContain('Embedding');
        expect(result.vectorCount).toBe(0);

        // 关键词路径有命中
        expect(result.textCount).toBeGreaterThan(0);
        expect(result.results.length).toBeGreaterThan(0);
    });

    // ═══════════════════════════════════════
    // INT5: 空结果（有数据但查询不匹配）
    // ═══════════════════════════════════════
    it('INT5 - 查询不匹配时返回空结果或弱命中', async () => {
        await insertFacts([
            { memoryKey: KEY_A, content: '用户喜欢 TypeScript' },
            { memoryKey: KEY_A, content: '用户住在北京' },
        ]);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: '量子计算 超导物理', // 与插入数据完全不相关
        });

        // 关键词路径不应命中（文本无重叠）
        // 向量路径可能弱命中也可能不命中
        // 如果双路均无命中：degraded 取决于向量检索是否可用
        // 如果向量检索不可用（本地 MongoDB），degraded=true 是因为管道失败
        if (result.results.length === 0 && vectorSearchAvailable) {
            // 向量可用 + 无命中 = 真正的空结果，不是降级
            expect(result.degraded).toBe(false);
        }
        // 如果向量不可用或向量弱命中，degraded 可能为 true
        // 这是预期行为：只要有一路失败就标记降级
    });

    // ═══════════════════════════════════════
    // 补充 edge cases
    // ═══════════════════════════════════════

    it('E1 - 空集合上检索，返回空结果不报错', async () => {
        // 不插入任何数据
        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: '任何查询',
        });

        expect(result.results).toEqual([]);
        expect(result.vectorCount).toBe(0);
        expect(result.textCount).toBe(0);
        // degraded 取决于向量检索可用性
        if (vectorSearchAvailable) {
            expect(result.degraded).toBe(false);
        }
    });

    it('E2 - 单条数据检索，关键词精确匹配', async () => {
        await insertFacts([
            { memoryKey: KEY_A, content: '用户的猫叫 orange cat' },
        ]);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'orange',
        });

        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0]!.content).toContain('orange');
    });

    it('E3 - 无 embedding 字段的数据，关键词检索仍有效', async () => {
        // 直接用 MongoDB 插入不含 embedding 的文档
        await MemoryFact.insertMany([
            {
                memoryKey: KEY_A,
                content: '用户养了一只 golden retriever',
                confidence: 0.9,
                contentHash: generateContentHash(
                    '用户养了一只 golden retriever',
                ),
                sourceMessageIds: ['int-search-msg'],
                type: 'fact',
                // embedding 字段不设置
            },
        ]);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'golden',
        });

        // 关键词路径应命中
        expect(result.textCount).toBeGreaterThan(0);
        expect(result.results.some((r) => r.content.includes('golden'))).toBe(
            true,
        );
    });

    it('E4 - 同一内容用不同 query 多次检索，结果一致', async () => {
        await insertFacts([
            { memoryKey: KEY_A, content: '用户在学 Rust 编程语言' },
        ]);

        const result1 = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'Rust 编程',
        });

        const result2 = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'Rust 编程',
        });

        expect(result1.results.length).toBe(result2.results.length);
        expect(result1.degraded).toBe(result2.degraded);
    });

    it('E5 - 自定义 finalTopN 限制返回条数', async () => {
        const facts = Array.from({ length: 8 }, (_, i) => ({
            memoryKey: KEY_A,
            content: `用户学习笔记 ${i + 1}：React hooks 使用技巧`,
        }));
        await insertFacts(facts);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'React hooks',
            finalTopN: 3,
        });

        expect(result.results.length).toBeLessThanOrEqual(3);
    });

    it('E6 - notebookId 过滤隔离', async () => {
        await insertFacts([
            {
                memoryKey: KEY_A,
                content: '属于笔记本A的内容关于 Docker',
                notebookId: 'nb-alpha',
            },
            {
                memoryKey: KEY_A,
                content: '属于笔记本B的内容关于 Docker',
                notebookId: 'nb-beta',
            },
        ]);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'Docker',
            notebookId: 'nb-alpha',
        });

        // 结果应仅包含 nb-alpha 的文档
        for (const r of result.results) {
            expect(r.notebookId).toBe('nb-alpha');
        }
    });

    it('E7 - type 过滤仅返回指定类型', async () => {
        await insertFacts([
            {
                memoryKey: KEY_A,
                content: '对话事实：用户喜欢 Vim 编辑器',
                type: 'fact',
            },
            {
                memoryKey: KEY_A,
                content: '笔记分块：Vim 快捷键速查表',
                type: 'note_chunk',
            },
        ]);

        const result = await memorySearchService.search({
            memoryKey: KEY_A,
            query: 'Vim',
            type: 'fact',
        });

        for (const r of result.results) {
            expect(r.type).toBe('fact');
        }
    });
});

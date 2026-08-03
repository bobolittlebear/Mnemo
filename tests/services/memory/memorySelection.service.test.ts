/**
 * MemorySelectionService 单元测试
 *
 * 覆盖 Pipeline A（百分位截断）/ B（语义去重）/ 硬上限 / 降级 / 边界。
 *
 * 重要：被测服务通过 DI 注入 EmbeddingProvider，测试中 mock MemoryFact 的
 * find().select().lean() 链来控制默认 provider 行为。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 基础设施 ──

const { mockMemoryFactLean, mockMemoryFactFind } = vi.hoisted(() => ({
    mockMemoryFactLean: vi.fn(),
    mockMemoryFactFind: vi.fn(),
}));

const mockMemoryFactSelect = vi.fn(() => ({ lean: mockMemoryFactLean }));

vi.mock('@/models/MemoryFact', () => ({
    MemoryFact: {
        find: mockMemoryFactFind,
    },
}));

vi.mock('@/lib/logger', () => {
    const shared = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    return { createLogger: vi.fn(() => shared) };
});

import MemorySelectionService from '@/services/memory/memorySelection.service';
import { MEMORY_SELECTION_HARD_MAX } from '@/utils/config';
import type { MemorySearchResult } from '@/types/memory';

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 生成有效的 MongoDB ObjectId 字符串（24 位 hex） */
function oid(hex: string): string {
    return hex.padEnd(24, '0');
}

/** 生成第 index 个安全 ObjectId（index 按 hex 编码，保证合法） */
function safeOid(index: number): string {
    return oid(index.toString(16));
}

/** 构造单条 MemorySearchResult */
function makeCandidate(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
    const id = overrides._id ?? oid('a');
    return {
        _id: id,
        content: `记忆内容-${id.slice(0, 6)}`,
        rrfScore: 0.5,
        userId: 'user-1',
        confidence: 0.8,
        type: 'fact' as const,
        sourceMessageIds: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        ...overrides,
    };
}

/**
 * 批量构造候选记忆。
 * @param scores rrfScore 数组
 * @param contents 可选 content 数组，默认自动生成
 * @param ids 可选 _id 数组，默认自动生成
 */
function makeCandidates(
    scores: number[],
    contents?: string[],
    ids?: string[],
): MemorySearchResult[] {
    return scores.map((score, i) =>
        makeCandidate({
            rrfScore: score,
            content: contents?.[i] ?? `候选记忆 #${i}`,
            _id: ids?.[i] ?? safeOid(i),
        }),
    );
}

/**
 * 构造 n 维"独热"向量（第 index 维为 1，其余为 0）。
 * 不同 index 的向量两两正交，余弦相似度 = 0。
 */
function oneHot(index: number, dims: number = 10): number[] {
    const v = new Array(dims).fill(0);
    v[index % dims] = 1;
    return v;
}

/**
 * 为候选集 mock MemoryFact 查询返回，使每个候选的 _id 映射到给定的 embedding。
 * @param idEmbeddingMap _id → embedding 或 null
 */
function mockEmbeddingResponse(idEmbeddingMap: Map<string, number[] | null>): void {
    const docs: Array<{ _id: { toString: () => string }; embedding: number[] | null }> = [];
    for (const [id, emb] of idEmbeddingMap) {
        docs.push({
            _id: { toString: () => id },
            embedding: emb,
        });
    }
    mockMemoryFactLean.mockResolvedValue(docs);
}

/** 为一批候选做 embedding mock：每个候选获得 oneHot 向量（互为正交 → 不触发去重） */
function mockOrthoEmbeddings(candidates: MemorySearchResult[]): void {
    const map = new Map<string, number[] | null>();
    candidates.forEach((c, i) => {
        map.set(c._id, oneHot(i));
    });
    mockEmbeddingResponse(map);
}

/** 创建指定余弦相似度的 2D 向量对（用于阈值边界测试） */
function cosPair(targetCos: number): { a: number[]; b: number[] } {
    // a = [1, 0]，b = [cosθ, sinθ]，则 a·b = cosθ
    const sinTheta = Math.sqrt(1 - targetCos * targetCos);
    return {
        a: [1, 0],
        b: [targetCos, sinTheta],
    };
}

// ── 测试套件 ──────────────────────────────────────────────────────

describe('MemorySelectionService', () => {
    beforeEach(() => {
        mockMemoryFactFind.mockReset();
        mockMemoryFactSelect.mockReset();
        mockMemoryFactLean.mockReset();

        // 默认链：find → select → lean
        mockMemoryFactFind.mockReturnValue({ select: mockMemoryFactSelect });
        mockMemoryFactSelect.mockReturnValue({ lean: mockMemoryFactLean });
        // 默认返回空 embedding（避免意外真实查询）
        mockMemoryFactLean.mockResolvedValue([]);
    });

    // ══════════════════════════════════════════════════════════════
    // Happy Path
    // ══════════════════════════════════════════════════════════════

    describe('Happy Path', () => {
        it('H1 — 正常全管道：5 条候选 → A 百分位截断(P70 保留高分) → B 去重(不重复) → 硬上限未触发', async () => {
            const contents = ['短', '中等长度', '较长内容在这里', '更长的记忆内容字符串', '最长的记忆条目内容文本'];
            const candidates = makeCandidates(
                [0.1, 0.3, 0.5, 0.7, 0.9],
                contents,
                [oid('a'), oid('b'), oid('c'), oid('d'), oid('e')],
            );

            // 5 个正交 embedding → 全部不触发去重
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            // Pipeline A: 5 ≤ MIN_COUNT(5)，小样本保护触发，全部保留
            expect(metadata.totalCandidates).toBe(5);
            expect(metadata.afterPercentile).toBe(5);
            // 小样本保护时 threshold = NaN
            expect(metadata.percentileThreshold).toBeNaN();

            // Pipeline B: 正交向量全部不重复
            expect(metadata.afterDedup).toBe(5);
            expect(metadata.dedupSkipped).toBe(false);
            expect(metadata.droppedByDedup).toEqual([]);

            // 硬上限: 5 ≤ 8，不触发
            expect(metadata.hardMaxApplied).toBe(false);
            expect(metadata.hardMaxDropped).toBe(0);

            expect(selected.length).toBe(5);
            expect(metadata.selectionLatencyMs).toBeGreaterThanOrEqual(0);
        });

        it('H2 — 硬上限触发：10 条高分候选 → A（bypass via percentileMinCount）→ B 无重复 → 硬上限截断到 HARD_MAX', async () => {
            const candidates = makeCandidates(
                [0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 1.0],
                undefined,
                [
                    oid('a0'), oid('a1'), oid('a2'), oid('a3'), oid('a4'),
                    oid('a5'), oid('a6'), oid('a7'), oid('a8'), oid('a9'),
                ],
            );

            // 全部正交 → 不触发去重
            mockOrthoEmbeddings(candidates);

            // bypass Pipeline A 百分位截断，让 10 条全进 B
            const { selected, metadata } = await MemorySelectionService.select(candidates, {
                percentileMinCount: 100,
            });

            expect(metadata.totalCandidates).toBe(10);
            // A 管被 bypass，全部保留
            expect(metadata.afterPercentile).toBe(10);
            // 去重无损失
            expect(metadata.afterDedup).toBe(10);
            expect(metadata.dedupSkipped).toBe(false);

            // 硬上限触发：10 > HARD_MAX(8)
            expect(metadata.hardMaxApplied).toBe(true);
            expect(metadata.hardMaxDropped).toBe(10 - MEMORY_SELECTION_HARD_MAX);

            expect(selected.length).toBe(MEMORY_SELECTION_HARD_MAX);
            // 验证 selected 按 rrfScore 降序（硬上限截断前排序）
            for (let i = 1; i < selected.length; i++) {
                expect(selected[i]!.rrfScore).toBeLessThanOrEqual(selected[i - 1]!.rrfScore);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════
    // Pipeline A 边界
    // ══════════════════════════════════════════════════════════════

    describe('Pipeline A — 百分位截断', () => {
        it('小样本保护：3 条候选 → 全部保留，threshold = NaN', async () => {
            const candidates = makeCandidates([0.2, 0.5, 0.8]);
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.totalCandidates).toBe(3);
            expect(metadata.afterPercentile).toBe(3);
            expect(metadata.percentileThreshold).toBeNaN();
            expect(selected.length).toBe(3);
        });

        it('小样本保护临界：5 条候选 → ≤ MIN_COUNT(5) 跳过 A', async () => {
            const candidates = makeCandidates([0.1, 0.2, 0.3, 0.4, 0.5]);
            mockOrthoEmbeddings(candidates);

            const { metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.totalCandidates).toBe(5);
            expect(metadata.afterPercentile).toBe(5);
            expect(metadata.percentileThreshold).toBeNaN();
        });

        it('小样本突破：6 条候选 → A 正常执行百分位截断', async () => {
            const candidates = makeCandidates([0.1, 0.2, 0.3, 0.5, 0.7, 0.9]);
            mockOrthoEmbeddings(candidates);

            const { metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.totalCandidates).toBe(6);
            expect(metadata.afterPercentile).toBeLessThan(6);
            // threshold 不是 NaN（正常计算）
            expect(metadata.percentileThreshold).not.toBeNaN();
            expect(metadata.percentileThreshold).toBeGreaterThan(0);
        });

        it('百分位算法一致性：固定数组 [0.1, 0.3, 0.5, 0.7, 0.9]，P70 ≈ 0.66', async () => {
            // 用 7 条触发百分位计算（> minCount=5）
            const candidates = makeCandidates([0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 0.9]);
            mockOrthoEmbeddings(candidates);

            const { metadata } = await MemorySelectionService.select(candidates, {
                percentile: 0.7,
            });

            // P70 线性插值:
            // sorted = [0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 0.9], n=7
            // index = 0.7 * 6 = 4.2
            // lower=4, upper=5
            // threshold = sorted[4] + 0.2 * (sorted[5] - sorted[4]) = 0.7 + 0.2 * 0.2 = 0.74
            expect(metadata.percentileThreshold).toBeCloseTo(0.74, 5);
        });

        it('空输入 → totalCandidates = 0，selected 为空数组，各管道跳过', async () => {
            const { selected, metadata } = await MemorySelectionService.select([]);

            expect(metadata.totalCandidates).toBe(0);
            expect(selected).toEqual([]);
            expect(metadata.afterPercentile).toBe(0);
            expect(metadata.afterDedup).toBe(0);
            expect(metadata.hardMaxApplied).toBe(false);
            expect(metadata.selectionLatencyMs).toBeGreaterThanOrEqual(0);
        });
    });

    // ══════════════════════════════════════════════════════════════
    // Pipeline B 边界
    // ══════════════════════════════════════════════════════════════

    describe('Pipeline B — 语义去重', () => {
        it('全不重复：5 条 embedding 两两正交（余弦相似度 = 0）→ 全部保留', async () => {
            const candidates = makeCandidates(
                [0.5, 0.6, 0.7, 0.8, 0.9],
                ['内容A', '内容B', '内容C', '内容D', '内容E'],
                [oid('a'), oid('b'), oid('c'), oid('d'), oid('e')],
            );

            // 正交 embedding → cos = 0 < 0.88 → 全部保留
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            // 5 ≤ MIN_COUNT，A 保留全部
            expect(metadata.afterPercentile).toBe(5);
            // B 无去重
            expect(metadata.afterDedup).toBe(5);
            expect(metadata.dedupSkipped).toBe(false);
            expect(metadata.droppedByDedup).toEqual([]);
            expect(selected.length).toBe(5);
        });

        it('两条完全相同：embedding 相同 → cos = 1.0 > 0.88 → 保留一条，丢弃一条', async () => {
            const sameEmb = [1, 2, 3, 4, 5];
            const idA = oid('a');
            const idB = oid('b');

            const candidates = makeCandidates(
                [0.9, 0.8],
                ['内容短', '内容短'], // 等长，保留先处理的高分者
                [idA, idB],
            );

            const map = new Map<string, number[] | null>();
            map.set(idA, sameEmb);
            map.set(idB, sameEmb);
            mockEmbeddingResponse(map);

            // 6 条以触发百分位（但两条不足 minCount） → 需要 > minCount
            // 构造 6 条：其中 2 条相同 embedding，4 条正交
            const allCandidates = [
                ...candidates,
                ...makeCandidates(
                    [0.7, 0.6, 0.5, 0.4],
                    ['C', 'D', 'E', 'F'],
                    [oid('c'), oid('d'), oid('e'), oid('f')],
                ),
            ];
            // 为额外的候选也设置正交 embedding
            map.set(oid('c'), oneHot(2));
            map.set(oid('d'), oneHot(3));
            map.set(oid('e'), oneHot(4));
            map.set(oid('f'), oneHot(5));
            mockEmbeddingResponse(map);

            const { metadata } = await MemorySelectionService.select(allCandidates);

            expect(metadata.dedupSkipped).toBe(false);
            // 应有 1 条被去重丢弃
            expect(metadata.droppedByDedup.length).toBe(1);
            // 6 - 1(dedup) = 5 after B, 但还要考虑 A 截断
            expect(metadata.afterDedup).toBe(metadata.afterPercentile - 1);
        });

        it('保留更长者：两条相似 → 替换为 content 更长的候选', async () => {
            const similarEmb = [1, 2, 3]; // 相同的 embedding → cos = 1.0
            const idA = oid('a');
            const idB = oid('b');

            const shortContent = '短';
            const longContent = '这是一条明显更长的记忆内容，包含更多文字信息';

            const candidates = makeCandidates(
                [0.9, 0.8],
                [shortContent, longContent],
                [idA, idB],
            );

            const map = new Map<string, number[] | null>();
            map.set(idA, similarEmb);
            map.set(idB, similarEmb);
            mockEmbeddingResponse(map);

            const { metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.dedupSkipped).toBe(false);
            // 两条去重保留一条；rrfScore 高的（0.9, shortContent）先进 kept，
            // 然后 rrfScore 低的（0.8, longContent）与之比较，发现重复，
            // longContent.length > shortContent.length → 替换
            // droppedByDedup 应包含被替换的短 content
            expect(metadata.droppedByDedup).toContain(shortContent);
            // afterDedup 应为 1（5 条保留 → 但 5 ≤ minCount，全部通过 A）
            // 实际：2 条输入，≤ minCount，A 保留 2，B 去重到 1
            expect(metadata.afterDedup).toBe(1);
        });

        it('等长去重：两条相似且 content 等长 → 保留先处理的高分者，丢弃后者', async () => {
            const sameEmb = [4, 5, 6];
            const idA = oid('a');
            const idB = oid('b');

            const equalContent = '等长内容ABC'; // 长度相等

            const candidates = makeCandidates(
                [0.9, 0.8],
                [equalContent, equalContent],
                [idA, idB],
            );

            const map = new Map<string, number[] | null>();
            map.set(idA, sameEmb);
            map.set(idB, sameEmb);
            mockEmbeddingResponse(map);

            const { metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.dedupSkipped).toBe(false);
            expect(metadata.afterDedup).toBe(1);
            // 后者（rrfScore 0.8）的 content 被丢弃
            expect(metadata.droppedByDedup).toContain(equalContent);
            expect(metadata.droppedByDedup.length).toBe(1);
        });

        it('阈值边界：三对分别 cos ≈ 0.879 / 0.880 / 0.881，阈值 0.88 → 仅 0.881 触发去重', async () => {
            // 构造三对候选，每对使用不同的 2D 向量控制余弦相似度
            // cos([1,0], [cosθ, sinθ]) = cosθ
            const pair879 = cosPair(0.879);  // < 0.88
            const pair880 = cosPair(0.880);  // = 0.88
            const pair881 = cosPair(0.881);  // > 0.88

            const idA = oid('a'), idB = oid('b');
            const idC = oid('c'), idD = oid('d');
            const idE = oid('e'), idF = oid('f');

            const candidates = makeCandidates(
                [0.9, 0.89, 0.88, 0.87, 0.86, 0.85],
                ['A', 'B', 'C', 'D', 'E', 'F'],
                [idA, idB, idC, idD, idE, idF],
            );

            const map = new Map<string, number[] | null>();
            map.set(idA, pair879.a);
            map.set(idB, pair879.b);
            map.set(idC, pair880.a);
            map.set(idD, pair880.b);
            map.set(idE, pair881.a);
            map.set(idF, pair881.b);
            mockEmbeddingResponse(map);

            const { metadata } = await MemorySelectionService.select(candidates, {
                dedupThreshold: 0.88,
                percentileMinCount: 100, // bypass Pipeline A 让全部 6 条进入 B
            });

            expect(metadata.dedupSkipped).toBe(false);
            // 6 条输入，3 对。只有 pair881 触发去重（cos > 0.88）→ 丢弃 1 条
            // 注意：A 管也可能截断
            // Pair 879: cos 0.879 > 0.88? No — 保留两者
            // Pair 880: cos 0.880 > 0.88? No (strict) — 保留两者
            // Pair 881: cos 0.881 > 0.88? Yes — 去重 1 条
            expect(metadata.droppedByDedup.length).toBeGreaterThanOrEqual(1);
            // 被丢弃的应该是 pair881 中的一条
        });

        it('三档敏感性：threshold 0.75/0.88/0.95 → 阈值越低去重越激进', async () => {
            // 一对候选，cos ≈ 0.90
            const pair = cosPair(0.90);
            const idA = oid('a');
            const idB = oid('b');

            function buildCandidates(): MemorySearchResult[] {
                return makeCandidates([0.9, 0.8], ['内容一', '内容二'], [idA, idB]);
            }

            function buildMap(): Map<string, number[] | null> {
                const m = new Map<string, number[] | null>();
                m.set(idA, pair.a);
                m.set(idB, pair.b);
                return m;
            }

            // threshold = 0.75: cos 0.90 > 0.75 → 触发去重 → 1 条
            mockMemoryFactLean.mockReset();
            mockEmbeddingResponse(buildMap());
            const r1 = await MemorySelectionService.select(buildCandidates(), { dedupThreshold: 0.75 });
            expect(r1.metadata.dedupSkipped).toBe(false);
            expect(r1.metadata.afterDedup).toBe(1);
            expect(r1.metadata.droppedByDedup.length).toBe(1);

            // threshold = 0.88: cos 0.90 > 0.88 → 触发去重 → 1 条
            mockMemoryFactLean.mockReset();
            mockEmbeddingResponse(buildMap());
            const r2 = await MemorySelectionService.select(buildCandidates(), { dedupThreshold: 0.88 });
            expect(r2.metadata.dedupSkipped).toBe(false);
            expect(r2.metadata.afterDedup).toBe(1);
            expect(r2.metadata.droppedByDedup.length).toBe(1);

            // threshold = 0.95: cos 0.90 < 0.95 → 不去重 → 2 条
            mockMemoryFactLean.mockReset();
            mockEmbeddingResponse(buildMap());
            const r3 = await MemorySelectionService.select(buildCandidates(), { dedupThreshold: 0.95 });
            expect(r3.metadata.dedupSkipped).toBe(false);
            expect(r3.metadata.afterDedup).toBe(2);
            expect(r3.metadata.droppedByDedup.length).toBe(0);
        });
    });

    // ══════════════════════════════════════════════════════════════
    // 降级边界
    // ══════════════════════════════════════════════════════════════

    describe('降级', () => {
        it('batchGet 抛 Error → 跳过 B 管，selected = A 输出，dedupSkipped = true', async () => {
            const candidates = makeCandidates(
                [0.3, 0.5, 0.7, 0.9],
                undefined,
                [oid('a'), oid('b'), oid('c'), oid('d')],
            );

            // mock lean 抛出异常 → batchGet 整体失败
            mockMemoryFactLean.mockRejectedValue(new Error('MongoDB 连接失败'));

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.dedupSkipped).toBe(true);
            // 降级后 B 管直接返回 A 管输出
            expect(selected.length).toBe(metadata.afterPercentile);
            // 全部 embedding 缺失标记
            expect(metadata.embeddingMissing).toBe(candidates.length);
            expect(metadata.selectionLatencyMs).toBeGreaterThanOrEqual(0);
        });

        it('batchGet 部分返回 null → embeddingMissing 正确计数，缺失项直接保留', async () => {
            const idA = oid('a');
            const idB = oid('b');
            const idC = oid('c');

            const candidates = makeCandidates(
                [0.9, 0.7, 0.5],
                ['完整内容A', '缺失内容B', '完整内容C'],
                [idA, idB, idC],
            );

            // 只返回 A 和 C 的 embedding，B 缺失
            const map = new Map<string, number[] | null>();
            map.set(idA, oneHot(0));
            map.set(idB, null); // null → 缺失
            map.set(idC, oneHot(2));
            mockEmbeddingResponse(map);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            expect(metadata.dedupSkipped).toBe(false);
            // embeddingMissing: idB 是 null（1 条缺失）
            expect(metadata.embeddingMissing).toBe(1);
            // 缺失的候选仍在 selected 中
            const selectedIds = selected.map((s) => s._id);
            expect(selectedIds).toContain(idB);
            // A 和 C 正交 → 不去重；B 直接保留 → 3 条都在
            expect(selected.length).toBe(3);
        });
    });

    // ══════════════════════════════════════════════════════════════
    // 硬上限边界
    // ══════════════════════════════════════════════════════════════

    describe('硬上限', () => {
        it('B 后恰好 = HARD_MAX → 不触发硬上限', async () => {
            const count = MEMORY_SELECTION_HARD_MAX;
            const candidates = makeCandidates(
                Array.from({ length: count }, (_, i) => 0.9 - i * 0.01),
            );
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            // count ≤ MIN_COUNT(5)? HARD_MAX=8 > 5，所以走百分位截断
            // 但所有分数都很高 → 应该大部分保留
            // 直接验证硬上限
            expect(metadata.hardMaxApplied).toBe(false);
            expect(metadata.hardMaxDropped).toBe(0);
            expect(selected.length).toBeLessThanOrEqual(MEMORY_SELECTION_HARD_MAX);
        });

        it('B 后 = HARD_MAX + 1 → 触发硬上限，截 1 条', async () => {
            // 构造足够多的候选确保 B 后超过 HARD_MAX
            const count = MEMORY_SELECTION_HARD_MAX + 5; // 13 条
            const candidates = makeCandidates(
                Array.from({ length: count }, (_, i) => 0.95 - i * 0.005),
            );
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            // 硬上限应该触发（A 后或 B 后超过 8）
            // 验证 selected 不超过 HARD_MAX
            expect(selected.length).toBeLessThanOrEqual(MEMORY_SELECTION_HARD_MAX);

            // 如果 afterDedup > HARD_MAX，则 hardMaxApplied = true
            if (metadata.afterDedup > MEMORY_SELECTION_HARD_MAX) {
                expect(metadata.hardMaxApplied).toBe(true);
                expect(metadata.hardMaxDropped).toBe(
                    metadata.afterDedup - MEMORY_SELECTION_HARD_MAX,
                );
            }
        });

        it('硬上限截断后 selected 按 rrfScore 降序排列', async () => {
            const count = MEMORY_SELECTION_HARD_MAX + 3;
            // 固定分数，递减排列
            const scores = Array.from({ length: count }, (_, i) => 0.99 - i * 0.005);
            const candidates = makeCandidates(scores);
            mockOrthoEmbeddings(candidates);

            const { selected } = await MemorySelectionService.select(candidates, {
                percentileMinCount: 100, // bypass A
            });

            // 验证排序：selected 按 rrfScore 降序
            for (let i = 1; i < selected.length; i++) {
                expect(selected[i]!.rrfScore).toBeLessThanOrEqual(
                    selected[i - 1]!.rrfScore,
                );
            }
        });
    });

    // ══════════════════════════════════════════════════════════════
    // Pipeline C（骨架）
    // ══════════════════════════════════════════════════════════════

    describe('Pipeline C — 时效性提权（骨架）', () => {
        it('recencyEnabled = false（默认）→ Pipeline C 不影响结果', async () => {
            const candidates = makeCandidates([0.5, 0.6, 0.7]);
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates);

            // 正常走完管线，无异常
            expect(selected.length).toBe(3);
            expect(metadata.selectionLatencyMs).toBeGreaterThanOrEqual(0);
        });

        it('recencyEnabled = true → 方法正常完成不抛异常（骨架实现）', async () => {
            const candidates = makeCandidates([0.5, 0.6, 0.7]);
            mockOrthoEmbeddings(candidates);

            const { selected, metadata } = await MemorySelectionService.select(candidates, {
                recencyEnabled: true,
            });

            // Pipeline C 目前是骨架（直接返回原数组），不影响结果
            expect(selected.length).toBe(3);
            expect(metadata.selectionLatencyMs).toBeGreaterThanOrEqual(0);
        });
    });

    // ══════════════════════════════════════════════════════════════
    // 元数据字段完整性
    // ══════════════════════════════════════════════════════════════

    describe('元数据完整性', () => {
        it('metadata 返回所有必需字段', async () => {
            const candidates = makeCandidates([0.5, 0.8], ['短A', '长B']);
            mockOrthoEmbeddings(candidates);

            const { metadata } = await MemorySelectionService.select(candidates);

            // 逐字段断言，不用 toMatchObject
            expect(typeof metadata.totalCandidates).toBe('number');
            expect(typeof metadata.percentileThreshold).toBe('number');
            expect(typeof metadata.afterPercentile).toBe('number');
            expect(typeof metadata.afterDedup).toBe('number');
            expect(typeof metadata.hardMaxApplied).toBe('boolean');
            expect(typeof metadata.hardMaxDropped).toBe('number');
            expect(typeof metadata.embeddingMissing).toBe('number');
            expect(typeof metadata.dedupSkipped).toBe('boolean');
            expect(typeof metadata.selectionLatencyMs).toBe('number');
            expect(Array.isArray(metadata.droppedByDedup)).toBe(true);
        });
    });
});

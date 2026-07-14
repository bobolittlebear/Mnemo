/**
 * rrfFusion 单元测试
 *
 * 测试目标：RRF 融合算法的核心逻辑
 * Mock 依赖：无（纯函数，无外部依赖）
 * 真实逻辑：跨路得分叠加、同路去重、排序、截断、null/空防御
 */
import { describe, it, expect } from 'vitest';
import { rrfFusion } from '@/services/memory/rrf';
import type { RankedDoc, MemorySearchResult } from '@/types/memory';

// ── 测试工具 ──────────────────────────────────────────────────

/** 构造 RankedDoc，减少样板代码 */
function makeDoc(overrides: Partial<RankedDoc> & { _id: string; rank: number }): RankedDoc {
    return {
        content: `content of ${overrides._id}`,
        memoryKey: 'test-key',
        confidence: 0.9,
        category: 'preference',
        type: 'fact',
        notebookId: undefined,
        sourceMessageIds: ['msg-1'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        rawScore: 0.5,
        ...overrides,
    };
}

/** 生成 N 条不重复 RankedDoc，rank 1~N */
function makePipeline(count: number, idPrefix = 'doc'): RankedDoc[] {
    return Array.from({ length: count }, (_, i) =>
        makeDoc({ _id: `${idPrefix}-${i + 1}`, rank: i + 1 }),
    );
}

/** 精度比较：断言实际值在期望值 ± epsilon 范围内 */
function expectClose(actual: number, expected: number, epsilon = 1e-6) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
}

// ── 测试用例 ──────────────────────────────────────────────────

describe('rrfFusion', () => {
    // ── 1. 同文档跨路得分叠加 ──
    it('ID1: 向量检索和关键词检索包含相同事实，分数累加正确', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 })],
            [makeDoc({ _id: 'A', rank: 2 })],
        ];

        const result = rrfFusion(pipelines, 60, 5);

        expect(result.length).toBe(1);
        // 1/(60+1) + 1/(60+2) = 1/61 + 1/62
        const expected = 1 / 61 + 1 / 62;
        expectClose(result[0]!.rrfScore, expected);
    });

    // ── 2. 仅向量检索包含该事实 ──
    it('ID2: 仅向量检索包含该事实，单路得分不丢失', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 3 })],
            [],
        ];

        const result = rrfFusion(pipelines, 60, 5);

        expect(result.length).toBe(1);
        expectClose(result[0]!.rrfScore, 1 / 63);
    });

    // ── 3. 仅关键词检索包含该事实 ──
    it('ID3: 仅关键词检索包含该事实，反向单路正常', () => {
        const pipelines: RankedDoc[][] = [
            [],
            [makeDoc({ _id: 'B', rank: 1 })],
        ];

        const result = rrfFusion(pipelines, 60, 5);

        expect(result.length).toBe(1);
        expectClose(result[0]!.rrfScore, 1 / 61);
    });

    // ── 4. 两路各 20 条不同文档，finalTopN=10 ──
    it('ID4: 两路各 20 条，finalTopN=10 截断且严格降序', () => {
        const pipelines: RankedDoc[][] = [
            makePipeline(20, 'vec'),
            makePipeline(20, 'txt'),
        ];

        const result = rrfFusion(pipelines, 60, 10);

        // 恰好 10 条
        expect(result.length).toBe(10);

        // 严格降序
        for (let i = 1; i < result.length; i++) {
            expect(result[i - 1]!.rrfScore).toBeGreaterThanOrEqual(
                result[i]!.rrfScore,
            );
        }
    });

    // ── 5. 两路无重叠，候选集 < topN ──
    it('ID5: 一路 4 条一路 6 条无重叠，finalTopN=10 全量返回且按分数降序', () => {
        const pipelines: RankedDoc[][] = [
            makePipeline(4, 'vec'),
            makePipeline(6, 'txt'),
        ];

        const result = rrfFusion(pipelines, 60, 10);

        // 全量返回 10 条
        expect(result.length).toBe(10);

        // rank 小的（分数高）排前面
        for (let i = 1; i < result.length; i++) {
            expect(result[i - 1]!.rrfScore).toBeGreaterThanOrEqual(
                result[i]!.rrfScore,
            );
        }
    });

    // ── 6. 一路空数组，一路 10 条 ──
    it('ID6: 一路为空数组，一路 10 条，返回 10 条', () => {
        const pipelines: RankedDoc[][] = [
            [],
            makePipeline(10, 'txt'),
        ];

        const result = rrfFusion(pipelines, 60, 10);

        expect(result.length).toBe(10);
        // 分数仅来自第二路
        expectClose(result[0]!.rrfScore, 1 / 61); // rank=1 的最高分
    });

    // ── 7. 一路 5 条，一路 null ──
    it('ID7: 一路 5 条，一路为 null，不抛异常返回 5 条', () => {
        const pipelines: any[] = [
            makePipeline(5, 'vec'),
            null,
        ];

        const result = rrfFusion(pipelines as RankedDoc[][], 60, 10);

        expect(result.length).toBe(5);
    });

    // ── 8. 两路都为空数组 ──
    it('ID8: 两路都为空数组，返回空数组', () => {
        const result = rrfFusion([[], []], 60, 10);

        expect(result).toEqual([]);
    });

    // ── 9. 两路都为 null ──
    it('ID9: 两路都为 null，不抛异常返回空数组', () => {
        const pipelines: any[] = [null, null];

        const result = rrfFusion(pipelines as RankedDoc[][], 60, 10);

        expect(result).toEqual([]);
    });

    // ── 10. RRF K=1，精确值验证（对称排名得分一致） ──
    it('ID10: k=1 时，对称排名的文档得分相等', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 }), makeDoc({ _id: 'B', rank: 2 })],
            [makeDoc({ _id: 'A', rank: 2 }), makeDoc({ _id: 'B', rank: 1 })],
        ];

        const result = rrfFusion(pipelines, 1, 2);

        expect(result.length).toBe(2);
        // A: 1/(1+1) + 1/(1+2) = 0.5 + 0.3333... = 0.8333...
        // B: 1/(1+2) + 1/(1+1) = 0.3333... + 0.5 = 0.8333...
        const expectedScore = 1 / 2 + 1 / 3;
        expectClose(result[0]!.rrfScore, expectedScore);
        expectClose(result[1]!.rrfScore, expectedScore);
    });

    // ── 11. 三路及以上融合 ──
    it('ID11: 三路融合，得分三路累加正确', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 })],
            [makeDoc({ _id: 'A', rank: 2 })],
            [makeDoc({ _id: 'A', rank: 3 })],
        ];

        const result = rrfFusion(pipelines, 60, 5);

        expect(result.length).toBe(1);
        // 1/61 + 1/62 + 1/63 ≈ 0.04880
        const expected = 1 / 61 + 1 / 62 + 1 / 63;
        expectClose(result[0]!.rrfScore, expected);
    });

    // ── 12. 同一路内重复 _id（去重验证） ──
    it('ID12: 同一路内重复 _id，仅计首次出现排名', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 }), makeDoc({ _id: 'A', rank: 5 })],
            [],
        ];

        const result = rrfFusion(pipelines, 60, 5);

        expect(result.length).toBe(1);
        // 同路去重：仅计 rank=1 的 1/61，不叠加 rank=5 的 1/65
        expectClose(result[0]!.rrfScore, 1 / 61);
    });

    // ── 13. topN=0 ──
    it('ID13: topN=0，返回空数组', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 })],
        ];

        const result = rrfFusion(pipelines, 60, 0);

        expect(result).toEqual([]);
    });

    // ── 14. 文档字段完整性 ──
    it('ID14: 融合结果包含全部业务字段，非仅 _id+分数', () => {
        const input = makeDoc({
            _id: 'full-doc',
            rank: 1,
            content: '用户偏好 TypeScript',
            memoryKey: 'session:abc',
            confidence: 0.95,
            category: 'preference',
            type: 'fact',
            notebookId: 'nb-001',
            sourceMessageIds: ['msg-1', 'msg-2'],
            createdAt: new Date('2026-07-01'),
            updatedAt: new Date('2026-07-02'),
        });

        const result = rrfFusion([[input]], 60, 1);

        expect(result.length).toBe(1);
        const doc = result[0]!;
        expect(doc._id).toBe('full-doc');
        expect(doc.content).toBe('用户偏好 TypeScript');
        expect(doc.memoryKey).toBe('session:abc');
        expect(doc.confidence).toBe(0.95);
        expect(doc.category).toBe('preference');
        expect(doc.type).toBe('fact');
        expect(doc.notebookId).toBe('nb-001');
        expect(doc.sourceMessageIds).toEqual(['msg-1', 'msg-2']);
        expect(doc.createdAt).toEqual(new Date('2026-07-01'));
        expect(doc.updatedAt).toEqual(new Date('2026-07-02'));
        expect(typeof doc.rrfScore).toBe('number');
    });

    // ── 15. 大 K 值衰减验证 ──
    it('ID15: 大 k 值时高低排名分数趋近（平滑效果）', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 }), makeDoc({ _id: 'B', rank: 100 })],
        ];

        const result = rrfFusion(pipelines, 1000, 2);

        expect(result.length).toBe(2);
        const scoreA = result.find((d) => d._id === 'A')!.rrfScore;
        const scoreB = result.find((d) => d._id === 'B')!.rrfScore;

        expectClose(scoreA, 1 / 1001);
        expectClose(scoreB, 1 / 1100);

        // 差值极小：≈ 0.00009
        const diff = scoreA - scoreB;
        expect(diff).toBeGreaterThan(0);
        expect(diff).toBeLessThan(0.0002);
    });

    // ── 补充 edge cases ──

    // ── E1. 单路输入（仅一路管道） ──
    it('E1: 单路管道输入，正常融合', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 }), makeDoc({ _id: 'B', rank: 2 })],
        ];

        const result = rrfFusion(pipelines, 60, 5);

        expect(result.length).toBe(2);
        expect(result[0]!.rrfScore).toBeGreaterThan(result[1]!.rrfScore);
    });

    // ── E2. 空管道数组（pipelines=[]） ──
    it('E2: pipelines 为空数组，返回空结果', () => {
        const result = rrfFusion([], 60, 10);

        expect(result).toEqual([]);
    });

    // ── E3. pipelines 包含 undefined 元素 ──
    it('E3: pipelines 包含 undefined 元素，跳过不抛异常', () => {
        const pipelines: any[] = [
            undefined,
            [makeDoc({ _id: 'A', rank: 1 })],
        ];

        const result = rrfFusion(pipelines as RankedDoc[][], 60, 5);

        expect(result.length).toBe(1);
        expectClose(result[0]!.rrfScore, 1 / 61);
    });

    // ── E4. topN 大于候选总数 ──
    it('E4: topN 大于实际候选数，返回全部不补零', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 })],
        ];

        const result = rrfFusion(pipelines, 60, 100);

        expect(result.length).toBe(1);
    });

    // ── E5. 相同 rrfScore 的文档排序稳定性 ──
    it('E5: 相同 rrfScore 的多文档，均被保留（不因同分丢失）', () => {
        // 两路各 1 条不同 _id，rank 均为 1，分数相同
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'X', rank: 1 })],
            [makeDoc({ _id: 'Y', rank: 1 })],
        ];

        const result = rrfFusion(pipelines, 60, 10);

        expect(result.length).toBe(2);
        expectClose(result[0]!.rrfScore, 1 / 61);
        expectClose(result[1]!.rrfScore, 1 / 61);
    });

    // ── E6. k=0 时极端得分 ──
    it('E6: k=0 时，rank=1 得分为 1（1/(0+1)），验证公式极端情况', () => {
        const pipelines: RankedDoc[][] = [
            [makeDoc({ _id: 'A', rank: 1 }), makeDoc({ _id: 'B', rank: 2 })],
        ];

        const result = rrfFusion(pipelines, 0, 5);

        expect(result.length).toBe(2);
        expectClose(result[0]!.rrfScore, 1 / 1); // rank=1 → 1/(0+1) = 1
        expectClose(result[1]!.rrfScore, 1 / 2); // rank=2 → 1/(0+2) = 0.5
    });
});

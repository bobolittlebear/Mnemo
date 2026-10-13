import { describe, it, expect } from 'vitest';
import {
    computeRecallAtK,
    macroAvg,
    bm25ComplementCount,
} from './note-recall.metrics';

describe('computeRecallAtK', () => {
    it('全命中：relevant 全部在 retrieved 前 K 内 → 1', () => {
        expect(computeRecallAtK(['a', 'b'], ['a', 'b', 'c'], 5)).toBe(1);
    });

    it('部分命中：relevant 一半在前 K 内 → 0.5', () => {
        expect(computeRecallAtK(['a', 'b'], ['a', 'x'], 5)).toBe(0.5);
    });

    it('边界：relevant 空 → 0（不除零）', () => {
        expect(computeRecallAtK([], ['a'], 5)).toBe(0);
    });

    it('边界：K 超过返回长度，按实际返回算', () => {
        expect(computeRecallAtK(['a', 'b', 'c'], ['a'], 5)).toBeCloseTo(1 / 3);
    });

    it('边界：K=0 → 0', () => {
        expect(computeRecallAtK(['a'], ['a'], 0)).toBe(0);
    });

    it('快照：多组输入', () => {
        expect([
            computeRecallAtK(['a', 'b'], ['a', 'c'], 2),
            computeRecallAtK(['x'], ['x', 'y'], 1),
            computeRecallAtK(['m', 'n'], ['m', 'n', 'o'], 3),
        ]).toMatchSnapshot();
    });
});

describe('macroAvg', () => {
    it('正常均值', () => {
        expect(macroAvg([0, 0.5, 1])).toBeCloseTo(0.5);
    });

    it('边界：空数组 → 0', () => {
        expect(macroAvg([])).toBe(0);
    });

    it('边界：单元素', () => {
        expect(macroAvg([0.3])).toBe(0.3);
    });
});

describe('bm25ComplementCount', () => {
    it('happy：向量漏、BM25 中 → 计数 +1', () => {
        const cases = [
            { relevantIds: ['a'], vectorTop5: ['x', 'y'], bm25Top5: ['a', 'z'] },
        ];
        expect(bm25ComplementCount(cases)).toBe(1);
    });

    it('happy：两者都中 → 不计（非互补）', () => {
        const cases = [
            { relevantIds: ['a'], vectorTop5: ['a'], bm25Top5: ['a'] },
        ];
        expect(bm25ComplementCount(cases)).toBe(0);
    });

    it('边界：向量中、BM25 漏 → 不计', () => {
        const cases = [
            { relevantIds: ['a'], vectorTop5: ['a'], bm25Top5: ['x'] },
        ];
        expect(bm25ComplementCount(cases)).toBe(0);
    });

    it('边界：空 cases → 0', () => {
        expect(bm25ComplementCount([])).toBe(0);
    });
});

/**
 * Token 预算配置常量 sanity 单元测试（M1）
 *
 * 只校验配置不变量与算式，不复制预算器逻辑：
 * - getInputBudget 按「maxInput − maxOutput − margin」计算，默认模型取 AI_MODEL
 * - ltmCategoryTokenCap 的 key 与 MemoryFact schema 的 category enum 完全一致
 * - 比例、floor、窗口轮数为约定值
 * - 未登记模型抛中文错误（不静默兜底）
 */
import { describe, it, expect } from 'vitest';
import {
    AI_MODEL,
    MODEL_REGISTRY,
    BUDGET_CONFIG,
    getInputBudget,
    getCategoryTokenCap,
    MEMORY_SELECTION_HARD_MAX,
    type CategoryTokenCap,
} from '@/utils/config';
import { MemoryFact } from '@/models/MemoryFact';

// 以 schema enum 为唯一事实来源，避免测试里再维护一份 category 字面量清单
function schemaCategories(): string[] {
    const path = MemoryFact.schema.path('category') as unknown as { enumValues: string[] };
    return path.enumValues;
}

// 索引签名 + noUncheckedIndexedAccess 下取值类型为 `| undefined`，集中收口以便强断言
function capOf(category: string): CategoryTokenCap {
    const cap = BUDGET_CONFIG.ltmCategoryTokenCap[category];
    if (!cap) throw new Error(`缺少 category 上限：${category}`);
    return cap;
}

describe('模型注册表与 getInputBudget', () => {
    it('qwen3.7-plus 规格与设计文档 §2 一致', () => {
        expect(MODEL_REGISTRY['qwen3.7-plus']).toEqual({
            contextWindow: 1_000_000,
            maxInputTokens: 991_000,
            maxOutputTokens: 128_000,
        });
    });

    it('qwen3.7-plus 输入预算为 991_000 − 128_000 − 5_000 = 858_000', () => {
        expect(getInputBudget('qwen3.7-plus')).toBe(858_000);
    });

    it('缺省参数取 AI_MODEL', () => {
        expect(getInputBudget()).toBe(getInputBudget(AI_MODEL));
    });

    it('每个已登记模型都满足 maxInput − maxOutput − margin，且低于 maxInputTokens', () => {
        for (const [name, spec] of Object.entries(MODEL_REGISTRY)) {
            const budget = getInputBudget(name);
            expect(budget).toBe(
                spec.maxInputTokens - spec.maxOutputTokens - BUDGET_CONFIG.marginTokens
            );
            expect(budget).toBeLessThan(spec.maxInputTokens);
            expect(budget).toBeGreaterThan(0);
        }
    });

    it('未登记模型抛中文错误而非静默兜底', () => {
        expect(() => getInputBudget('gpt-unknown')).toThrow('未登记的模型「gpt-unknown」');
        expect(() => getInputBudget('gpt-unknown')).toThrow(Error);
    });
});

describe('BUDGET_CONFIG 恒定值', () => {
    it('四块比例与逐出下限为约定值', () => {
        expect(BUDGET_CONFIG.marginTokens).toBe(5_000);
        expect(BUDGET_CONFIG.systemMaxRatio).toBe(0.1);
        expect(BUDGET_CONFIG.stmMaxRatio).toBe(0.3);
        expect(BUDGET_CONFIG.ragMaxRatio).toBe(0.25);
        expect(BUDGET_CONFIG.ragFloor).toBe(5);
        expect(BUDGET_CONFIG.ltmFloor).toBe(4);
    });

    it('LTM 硬上限复用 MEMORY_SELECTION_HARD_MAX 语义', () => {
        expect(BUDGET_CONFIG.ltmHardMax).toBe(MEMORY_SELECTION_HARD_MAX);
        expect(BUDGET_CONFIG.ltmHardMax).toBe(8);
    });

    it('STM 窗口 20 轮、must-fit 最近轮数落在 3–5 区间', () => {
        expect(BUDGET_CONFIG.stmWindowRounds).toBe(20);
        expect(BUDGET_CONFIG.mustFitRecentRounds).toBe(5);
        expect(BUDGET_CONFIG.mustFitRecentRounds).toBeGreaterThanOrEqual(3);
        expect(BUDGET_CONFIG.mustFitRecentRounds).toBeLessThanOrEqual(5);
        expect(BUDGET_CONFIG.mustFitRecentRounds).toBeLessThan(BUDGET_CONFIG.stmWindowRounds);
    });

    it('各伸缩比例均 > 0 且 < 1（为自由池留出空间）', () => {
        const ratios = [
            BUDGET_CONFIG.systemMaxRatio,
            BUDGET_CONFIG.stmMaxRatio,
            BUDGET_CONFIG.ragMaxRatio,
        ];
        for (const ratio of ratios) {
            expect(ratio).toBeGreaterThan(0);
            expect(ratio).toBeLessThan(1);
        }
        expect(
            BUDGET_CONFIG.systemMaxRatio +
                BUDGET_CONFIG.stmMaxRatio +
                BUDGET_CONFIG.ragMaxRatio
        ).toBeLessThan(1);
    });
});

describe('LTM category 单条 token 上限表', () => {
    it('key 与 schema category enum 完全一致', () => {
        expect(Object.keys(BUDGET_CONFIG.ltmCategoryTokenCap).sort()).toEqual(
            schemaCategories().sort()
        );
        expect(schemaCategories().length).toBe(11);
    });

    it('event 上限为 [300, 800]，超出 800 触发压缩', () => {
        expect(capOf('event')).toEqual([300, 800]);
        expect(capOf('event')[1]).toBe(800);
    });

    it('各类别与设计文档 §8 数值一致', () => {
        expect(capOf('preference')).toEqual([80, 200]);
        expect(capOf('personal_info')).toEqual([100, 250]);
        expect(capOf('decision')).toEqual([200, 400]);
        expect(capOf('behavior_pattern')).toEqual([100, 250]);
        expect(capOf('relationship')).toEqual([150, 400]);
        expect(capOf('diet')).toEqual([60, 150]);
        expect(capOf('skill')).toEqual([100, 300]);
        expect(capOf('goal')).toEqual([200, 500]);
        expect(capOf('instruction')).toEqual([80, 200]);
        expect(capOf('other')).toEqual([150, 400]);
    });

    it('每个区间都是 min < max 的正整数对', () => {
        for (const category of schemaCategories()) {
            const [min, max] = capOf(category);
            expect(Number.isInteger(min)).toBe(true);
            expect(Number.isInteger(max)).toBe(true);
            expect(min).toBeGreaterThan(0);
            expect(min).toBeLessThan(max);
        }
    });

    it('单条上限均不超 800（LTM 固定槽 8 × ≤800 的前提）', () => {
        for (const category of schemaCategories()) {
            expect(capOf(category)[1]).toBeLessThanOrEqual(800);
        }
    });

    it('getCategoryTokenCap 契约：返回 [min, max]，供 M3 注入侧防御截断使用', () => {
        expect(getCategoryTokenCap('event')).toEqual([300, 800]);
        expect(getCategoryTokenCap('diet')).toEqual([60, 150]);
        // 缺省与未登记分类都回落到 other，注入侧永远拿得到上限
        expect(getCategoryTokenCap()).toEqual([150, 400]);
        expect(getCategoryTokenCap('未登记的新分类')).toEqual([150, 400]);
    });
});

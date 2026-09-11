/**
 * 遗忘机制配置常量 sanity 单元测试（M2）
 *
 * 只校验配置不变量，不复制判定逻辑：
 * - FORGET_INACTIVE_DAYS 的 key 与 MemoryFact schema 的 category enum 完全一致
 * - 各 category 阈值与设计文档 §4 表一致
 * - FORGET_CONFIDENCE_FLOOR / FORGET_MAX_DELETES_PER_RUN 为约定值
 * - FORGET_NEVER_DELETE ⊆ FORGET_INACTIVE_DAYS 的 key 集合
 */
import { describe, it, expect } from 'vitest';
import {
    FORGET_INACTIVE_DAYS,
    FORGET_CONFIDENCE_FLOOR,
    FORGET_NEVER_DELETE,
    FORGET_MAX_DELETES_PER_RUN,
} from '@/utils/config';
import { MemoryFact } from '@/models/MemoryFact';

// 以 schema enum 为唯一事实来源，避免测试里再维护一份 category 字面量清单
function schemaCategories(): string[] {
    const path = MemoryFact.schema.path('category') as unknown as { enumValues: string[] };
    return path.enumValues;
}

describe('遗忘机制配置常量', () => {
    it('FORGET_INACTIVE_DAYS 的 key 与 schema category enum 完全一致', () => {
        expect(Object.keys(FORGET_INACTIVE_DAYS).sort()).toEqual(schemaCategories().sort());
        expect(schemaCategories().length).toBe(11);
    });

    it('FORGET_INACTIVE_DAYS 各 category 阈值与设计文档一致', () => {
        expect(FORGET_INACTIVE_DAYS).toEqual({
            event: 14,
            instruction: 30,
            preference: 120,
            behavior_pattern: 120,
            skill: 120,
            personal_info: 180,
            relationship: 180,
            goal: 60,
            decision: 60,
            diet: 30,
            other: 14,
        });
    });

    it('FORGET_CONFIDENCE_FLOOR 为 0.7', () => {
        expect(FORGET_CONFIDENCE_FLOOR).toBe(0.7);
    });

    it('FORGET_MAX_DELETES_PER_RUN 为 50', () => {
        expect(FORGET_MAX_DELETES_PER_RUN).toBe(50);
    });

    it('FORGET_NEVER_DELETE 恰为 instruction / preference，且是阈值表的子集', () => {
        expect([...FORGET_NEVER_DELETE]).toEqual(['instruction', 'preference']);

        for (const category of FORGET_NEVER_DELETE) {
            expect(Object.keys(FORGET_INACTIVE_DAYS)).toContain(category);
        }
    });
});

/**
 * MemoryFact 模型单元测试（遗忘机制 M1）
 *
 * 验收标准：
 * - lastSignificantAt 字段可被赋值为 Date
 * - lastSignificantAt 为可选字段（缺失时校验通过）
 * - 复合索引 { userId: 1, type: 1, category: 1, lastSignificantAt: 1 } 已声明且字段顺序一致
 * - 既有索引未被误删
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { MemoryFact } from '@/models/MemoryFact';
import type { MemoryFact as RawMemoryFact } from '@/types/models';

// ── 构造最小合法记忆文档 ──
function buildFact(overrides: Partial<RawMemoryFact> = {}) {
    return new MemoryFact({
        userId: 'u1',
        content: '用户喜欢喝美式',
        sourceMessageIds: ['m1'],
        confidence: 0.8,
        category: 'preference',
        contentHash: 'hash-1',
        ...overrides,
    });
}

/** 取出索引声明中的字段对象列表，键顺序敏感（MongoDB 复合索引前缀依赖顺序） */
function declaredIndexFields(): Record<string, unknown>[] {
    return MemoryFact.schema.indexes().map(([fields]) => fields as Record<string, unknown>);
}

describe('MemoryFact 模型 — lastSignificantAt 字段与索引', () => {
    it('Schema 编译通过，模型可在已有连接上注册而不抛错', () => {
        expect(mongoose.models.MemoryFact).toBe(MemoryFact);
    });

    it('lastSignificantAt 可被赋值为 Date 实例', () => {
        const stamp = new Date('2026-09-01T00:00:00.000Z');
        const doc = buildFact({ lastSignificantAt: stamp });

        expect(doc.lastSignificantAt).toBeInstanceOf(Date);
        expect(doc.lastSignificantAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('lastSignificantAt 为可选字段：缺失时文档校验通过', () => {
        const doc = buildFact();

        expect(doc.lastSignificantAt).toBeUndefined();
        expect(doc.validateSync()).toBeUndefined();
    });

    it('声明了字段顺序一致的复合索引 { userId, type, category, lastSignificantAt }', () => {
        const target = ['userId', 'type', 'category', 'lastSignificantAt'];

        const matched = declaredIndexFields().filter(
            (fields) => JSON.stringify(Object.keys(fields)) === JSON.stringify(target),
        );

        expect(matched.length).toBe(1);
        expect(matched[0]).toEqual({ userId: 1, type: 1, category: 1, lastSignificantAt: 1 });
    });

    it('既有索引保持原样未被误删', () => {
        const fields = declaredIndexFields();

        expect(fields).toContainEqual({ userId: 1, createdAt: -1 });
        expect(fields).toContainEqual({ searchText: 'text' });
        expect(fields).toContainEqual({ userId: 1, notebookId: 1, type: 1, createdAt: -1 });
        expect(fields).toContainEqual({ userId: 1, contentHash: 1 });
    });

    it('未引入任何打分字段', () => {
        const pathNames = Object.keys(MemoryFact.schema.paths);

        expect(pathNames.filter((name) => /score/i.test(name))).toEqual([]);
    });
});
